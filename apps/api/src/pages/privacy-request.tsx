/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { PrivacyRequestForm } from "@ros/contracts";
import { audit, createDataRequest, noticesFor, normalizeEmail, openPayload, sealPayload } from "@ros/core";
import { sendPrivacyAcknowledgment } from "@ros/agents";
import { applications, candidates, companies, dataRequests, uuidv7, withPlatform } from "@ros/db";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { addressMatch } from "../services/applications";
import { Icon } from "./icons";
import { Layout } from "./layout";
import { CARD_PAGE_CSS } from "./signin-link";

/**
 * The public privacy-request form (audit finding D13): anyone can ask for a copy, a correction or deletion of their
 * information without a status link. Sending the form records nothing: the request itself travels, sealed, inside a
 * single-use link emailed to the address (24 hours), one per employer that holds a record under it. Opening the link
 * shows a page with one button; pressing the button creates the request, already verified, and sends the
 * acknowledgment. So a mail scanner that opens the link confirms nothing, a request nobody confirms leaves no row, no
 * deadline and no alert behind, and the page never says whether an address is known: the mailbox learns that, nobody
 * else. The link goes out directly, not through the candidate's message thread, because it exists only to prove
 * control of the mailbox and is not for the hiring team to read.
 */
export const privacyRequestPages = new Hono<Vars>();

const VERIFY_TTL_MS = 24 * 3600_000;
const VERIFY_PURPOSE = "privacy_request_verify";
/** The whole request, sealed. The reference is minted here so the email and the page can name it before the row exists. */
type VerifyToken = { v: 2; id: string; email: string; kind: PrivacyRequestForm["kind"]; details?: string; companyId: string; candidateId: string | null; applicationId: string | null; exp: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_LABEL: Record<string, string> = { access: "Send me a copy of my information", correct: "Correct something in my information", delete: "Delete my information" };
const KIND_WORDS: Record<string, string> = { access: "a copy of the information", correct: "a correction to the information", delete: "deletion of the information" };

function openVerifyToken(secret: string, token: string | undefined, now: Date): VerifyToken | null {
  const p = openPayload<VerifyToken>(VERIFY_PURPOSE, token, secret, now.getTime());
  if (p?.v !== 2 || typeof p.id !== "string" || !UUID.test(p.id) || typeof p.email !== "string" || !p.email || !KIND_WORDS[p.kind] || typeof p.companyId !== "string") return null;
  return p;
}

function RequestForm(props: { privacyEmail: string; company: string | null; error?: string; values?: { email?: string; kind?: string; details?: string } }) {
  const privacy = noticesFor(["*"]).find((n) => n.key === "privacy");
  const v = props.values ?? {};
  return (
    <Layout title="Request, correct or delete your information" extraCss={CARD_PAGE_CSS}>
      <p class="back"><a href="/privacy"><Icon name="arrow-left" />How we handle your information</a></p>
      <p class="eyebrow">Privacy</p>
      <h1>Your information</h1>
      <p class="lead">Ask for a copy of what we hold about you, correct it, or have it deleted. Use the email address you applied with.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" action="/c/privacy-request" class="card">
        {props.company ? <input type="hidden" name="company" value={props.company} /> : null}
        <div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex={-1} autocomplete="off" /></div>
        <label for="email" class="flush">Your email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={v.email ?? ""} />
        <label for="kind">What would you like?</label>
        <select id="kind" name="kind" required>
          {Object.entries(KIND_LABEL).map(([k, label]) => <option value={k} selected={v.kind === k}>{label}</option>)}
        </select>
        <label for="details">Details (optional)</label>
        <textarea id="details" name="details" rows={3} maxlength={2000} placeholder="For example: my phone number is wrong, it should be ...">{v.details ?? ""}</textarea>
        <p class="meta">We email that address a link to confirm it is you; nothing happens until you open it and press the button.</p>
        {/* The notice, word for word, one click away (founder brief, 14 October 2026). */}
        <details class="more">
          <summary>Read the full notice</summary>
          <p class="notice">
            <strong>What we collect and why:</strong> the information you gave when you applied (your name, contact details, résumé, your answers and any screening conversation), to consider you for employment. <strong>Who can see it:</strong> the hiring team at the employer, an Identified Talent Solutions recruiter only if the employer brings one in to help, and the service providers that store files and deliver email on our behalf. <strong>How this works:</strong> a person handles every request; nothing is decided by software. We confirm receipt and completion by email. Deleting keeps only what the law requires, without your name or contact details.
          </p>
          <p class="notice">{privacy?.text}</p>
        </details>
        <button class="btn" type="submit">Send me the confirmation link</button>
      </form>
      <p class="foot">Prefer email? Write to <a href={`mailto:${props.privacyEmail}`}>{props.privacyEmail}</a> from the address you applied with.</p>
    </Layout>
  );
}

privacyRequestPages.get("/c/privacy-request", async (c) => {
  const company = (c.req.query("company") ?? "").trim().slice(0, 80) || null;
  return c.html(<RequestForm privacyEmail={c.get("container").env.PRIVACY_EMAIL} company={company} />);
});

/** What every submission answers, whether or not an address is known: the confirmation is in the mailbox. */
function SentPage(props: { email: string }) {
  return (
    <Layout title="Check your email" extraCss={CARD_PAGE_CSS}>
      <p class="eyebrow">Privacy</p>
      <h1>Check your email</h1>
      <div class="card" role="status">
        <p><strong>We sent a confirmation link to {props.email}.</strong></p>
        <p>Open it within 24 hours and press the button to confirm your request. If we hold no information under that address, the email says so and how a person can help. Nothing happens until you confirm.</p>
      </div>
      <p class="foot">No email after a few minutes? Check the spam folder, or use the address you applied with. <a href="/c/privacy-request">Send the form again</a>.</p>
    </Layout>
  );
}

privacyRequestPages.post("/c/privacy-request", rateLimit(POLICIES.privacyForm), async (c) => {
  const container = c.get("container");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const company = str("company").trim().slice(0, 80) || null;
  const parsed = PrivacyRequestForm.safeParse({ email: str("email").trim(), kind: str("kind"), details: str("details").trim() || undefined, company: company ?? undefined, website: str("website") || undefined });
  if (!parsed.success) {
    // the honeypot looks like success to a bot and records nothing
    if (str("website")) return c.html(<SentPage email={str("email").trim() || "your address"} />);
    return c.html(<RequestForm privacyEmail={container.env.PRIVACY_EMAIL} company={company} error="Please check your email address and what you would like, then send again." values={{ email: str("email"), kind: str("kind"), details: str("details") }} />, 400);
  }
  const email = normalizeEmail(parsed.data.email);
  const now = container.engine.clock();
  // The employers that hold a record under this address, plus the one the form named (a link from a careers page).
  // A read only: nothing is written until the person confirms from the mailbox.
  const targets = await withPlatform(container.db, async (tx) => {
    // The same address-matching rule as "Lost your link?" (known-bugs row 68): the folded key, or the exact address.
    const match = addressMatch(email);
    const matches = match ? await tx.select({ id: candidates.id, companyId: candidates.companyId, email: candidates.email }).from(candidates).where(and(match, isNull(candidates.anonymizedAt))).orderBy(desc(candidates.createdAt)).limit(20) : [];
    const byCompany = new Map<string, { id: string; email: string | null } | null>();
    for (const m of matches) if (!byCompany.has(m.companyId)) byCompany.set(m.companyId, { id: m.id, email: m.email });
    if (parsed.data.company) {
      const [named] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.slug, parsed.data.company)).limit(1);
      if (named && !byCompany.has(named.id)) byCompany.set(named.id, null);
    }
    // The confirmation goes to the address the employer has on file (the typed one may only fold to it); otherwise to the typed one.
    const out: Array<{ companyId: string; companyName: string; candidateId: string | null; applicationId: string | null; to: string }> = [];
    for (const [companyId, person] of byCompany) {
      const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
      const [app] = person ? await tx.select({ id: applications.id }).from(applications).where(eq(applications.candidateId, person.id)).orderBy(desc(applications.createdAt)).limit(1) : [];
      out.push({ companyId, companyName: co?.name ?? "the hiring team", candidateId: person?.id ?? null, applicationId: app?.id ?? null, to: person?.email ? normalizeEmail(person.email) : email });
    }
    return out;
  });
  const link = (token: string) => `${container.env.APP_BASE_URL}/c/privacy-request/verify/${encodeURIComponent(token)}`;
  // Sent directly, outside any transaction (the way sign-in links are sent): never queued into the candidate's thread.
  for (const t of targets) {
    const id = uuidv7(now.getTime());
    const token = sealPayload<VerifyToken>(VERIFY_PURPOSE, { v: 2, id, email: t.to, kind: parsed.data.kind, ...(parsed.data.details ? { details: parsed.data.details } : {}), companyId: t.companyId, candidateId: t.candidateId, applicationId: t.applicationId, exp: now.getTime() + VERIFY_TTL_MS }, container.env.SESSION_SECRET);
    const sent = await container.integrations.email.send({
      to: t.to, from: `${t.companyName} privacy requests <${container.integrations.env.fromAddress}>`, replyTo: container.env.PRIVACY_EMAIL,
      subject: `Confirm your request (${id.slice(0, 8)})`,
      text: `Hello,\n\nSomeone asked, using this address, for ${KIND_WORDS[parsed.data.kind]} held by ${t.companyName}.\n\nIf that was you, open this link within 24 hours and press the button to confirm:\n${link(token)}\n\nIf it was not you, ignore this email; nothing happens without the button.\n\nQuestions? Write to ${container.env.PRIVACY_EMAIL}.\n\nIdentified Talent Solutions, on behalf of ${t.companyName}`,
      idempotencyKey: `privacy_verify:${id}`, tags: { template: "privacy_verify" },
    });
    if (sent.status === "failed") return c.html(<RequestForm privacyEmail={container.env.PRIVACY_EMAIL} company={company} error={`We could not send the confirmation email just now. Try again in a few minutes, or write to ${container.env.PRIVACY_EMAIL} from the address you applied with.`} values={{ email: parsed.data.email, kind: parsed.data.kind, details: parsed.data.details ?? "" }} />, 503);
  }
  if (!targets.length) {
    // Only the mailbox learns that nothing was found; a person can still help from there.
    await container.integrations.email.send({ to: email, from: `${container.env.PRODUCT_NAME} privacy requests <${container.integrations.env.fromAddress}>`, replyTo: container.env.PRIVACY_EMAIL, subject: "About your privacy request", text: `Hello,\n\nSomeone asked, using this address, for ${KIND_WORDS[parsed.data.kind]}. We found no application under ${email}.\n\nIf you applied with a different address, send the form again from that address: ${container.env.APP_BASE_URL}/c/privacy-request\n\nIf you believe we do hold information about you, reply to this email and a person will look into it.\n\nIdentified Talent Solutions`, idempotencyKey: `privacy_form_unknown:${email}:${Math.floor(now.getTime() / 3600_000)}`, tags: { template: "privacy_form_unknown" } });
  }
  return c.html(<SentPage email={email} />);
});

function LinkPage(props: { title: string; body: string }) {
  return (
    <Layout title={props.title} extraCss={CARD_PAGE_CSS}>
      <p class="eyebrow">Privacy</p>
      <h1>{props.title}</h1>
      <div class="card" role="status"><p>{props.body}</p></div>
      <p class="foot"><a href="/c/privacy-request">Send a new request</a> · <a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

const deadLinkPage = (c: Context<Vars>) => c.html(<LinkPage title="This link is no longer valid" body="Confirmation links work for 24 hours. Send the form again and we will email a new one." />, 410);
const usedLinkPage = (c: Context<Vars>, requestId: string) => c.html(<LinkPage title="Already confirmed" body={`This request (reference ${requestId.slice(0, 8)}) is confirmed already and a person is handling it; there is nothing more to do.`} />, 410);

/**
 * Opening the link only shows what would be confirmed and one button: a mail scanner or a preview that fetches the
 * page changes nothing. A dead or forged link says so; a link whose request exists already says so.
 */
privacyRequestPages.get("/c/privacy-request/verify/:token", async (c) => {
  const container = c.get("container");
  const now = container.engine.clock();
  const token = c.req.param("token");
  const payload = openVerifyToken(container.env.SESSION_SECRET, token, now);
  if (!payload) return deadLinkPage(c);
  const state = await withPlatform(container.db, async (tx) => {
    const [existing] = await tx.select({ id: dataRequests.id }).from(dataRequests).where(eq(dataRequests.id, payload.id)).limit(1);
    if (existing) return { used: true as const };
    const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, payload.companyId)).limit(1);
    return { used: false as const, companyName: co?.name ?? "the hiring team" };
  });
  if (state.used) return usedLinkPage(c, payload.id);
  return c.html(
    <Layout title="Confirm your request" extraCss={CARD_PAGE_CSS}>
      <p class="eyebrow">Privacy</p>
      <h1>Confirm your request</h1>
      <div class="card">
        <p>Someone asked, using <strong>{payload.email}</strong>, for {KIND_WORDS[payload.kind]} held by <strong>{state.companyName}</strong>. Reference {payload.id.slice(0, 8)}.</p>
        <form method="post" action="/c/privacy-request/verify">
          <input type="hidden" name="token" value={token} />
          <button class="btn" type="submit">Yes, confirm my request</button>
        </form>
      </div>
      <p class="foot">Not you? Close this page; nothing happens until the button is pressed. Questions? Write to <a href={`mailto:${container.env.PRIVACY_EMAIL}`}>{container.env.PRIVACY_EMAIL}</a>.</p>
    </Layout>,
  );
});

/** The button: creates the request, already verified by the link, and sends the acknowledgment. Once per link. */
privacyRequestPages.post("/c/privacy-request/verify", rateLimit(POLICIES.privacyVerify), async (c) => {
  const container = c.get("container");
  const now = container.engine.clock();
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const payload = openVerifyToken(container.env.SESSION_SECRET, typeof form.token === "string" ? form.token : undefined, now);
  if (!payload) return deadLinkPage(c);
  const result = await withPlatform(container.db, async (tx) => {
    const [existing] = await tx.select().from(dataRequests).where(eq(dataRequests.id, payload.id)).limit(1);
    if (existing) return { kind: "used" as const, row: existing };
    const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, payload.companyId)).limit(1);
    if (!co) return { kind: "gone" as const };
    const actor = payload.candidateId ? { kind: "candidate" as const, id: payload.candidateId } : { kind: "system" as const, id: "privacy_form" };
    // The same person confirming a second link for the same request within a day: the first record stands, with a
    // note in the ledger instead of a twin for the handler to close.
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const [same] = await tx.select().from(dataRequests).where(and(eq(dataRequests.companyId, payload.companyId), eq(dataRequests.requesterEmail, payload.email), eq(dataRequests.kind, payload.kind), eq(dataRequests.channel, "email_form"), inArray(dataRequests.status, ["received", "in_progress", "awaiting_counsel"]), gte(dataRequests.createdAt, since))).orderBy(desc(dataRequests.createdAt)).limit(1);
    if (same) {
      await audit(tx, { companyId: payload.companyId, actor, action: "data_request.replayed", target: { type: "candidate", id: payload.candidateId ?? same.id }, reason: payload.kind, details: { requestId: same.id, channel: "email_form" } });
      return { kind: "used" as const, row: same };
    }
    const row = await createDataRequest(tx, { id: payload.id, companyId: payload.companyId, kind: payload.kind, requesterEmail: payload.email, details: payload.details ?? null, candidateId: payload.candidateId, applicationId: payload.applicationId, channel: "email_form", verified: true, verificationNote: "the requester confirmed the address by the link we emailed", actor, now });
    await sendPrivacyAcknowledgment(tx, container.integrations, { row, companyName: co.name, privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return { kind: "ok" as const, row };
  });
  await container.kick();
  if (result.kind === "gone") return c.html(<LinkPage title="This link is no longer valid" body="We could not find the employer behind it. Send the form again and we will email a new link." />, 410);
  if (result.kind === "used") return usedLinkPage(c, result.row.id);
  const due = new Date(result.row.slaDueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return c.html(
    <Layout title="Thanks, your request is confirmed" extraCss={CARD_PAGE_CSS}>
      <p class="eyebrow">Privacy</p>
      <h1>Thanks, your request is confirmed</h1>
      <div class="card" role="status">
        <p><strong>Reference {result.row.id.slice(0, 8)}.</strong></p>
        <p>A person will handle it and we will complete it by {due}. We confirm by email when it is done. Questions? Write to <a href={`mailto:${container.env.PRIVACY_EMAIL}`}>{container.env.PRIVACY_EMAIL}</a>.</p>
      </div>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});
