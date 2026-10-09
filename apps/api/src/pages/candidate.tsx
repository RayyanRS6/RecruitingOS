/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ApplyRequest, CANDIDATE_STEP_LABEL, CandidateSmsPreference, CandidateStep, MAX_RESUME_BYTES, SCREEN_PERSON_ROUTE_STATUSES, TapAnswer, inspectResumeFile, isCompanyVerified, type ApplicationStage, type DecisionWording, type ReviewItem, type RolePacket, type TapFormat } from "@ros/contracts";
import { MOVED_ON_MESSAGE, SKIPPED_MESSAGE, WITHDRAW_CONFIRM_KEY } from "@ros/agents";
import { CLOSING_DATE_REASON, DECISION_STAGES, applyByLabel, audit, benefitsDescriptionFor, candidateStep, closingDayWords, createDataRequest, decisionTold, emit, fulfilSmsOptOut, fulfilWithdrawal, jobNoticesFor, mayWithdraw, noticesFor, notify, openHumanReview, openPayload, sealPayload, transition, type Notice } from "@ros/core";
import { CandidatePrivacyRequest } from "@ros/contracts";
import { sendPrivacyAcknowledgment, sendPrivacyCompletion } from "@ros/agents";
import { applications, candidates, companies, dataRequests, events, interviews, rolePackets, roles, screens, uuidv7, withPlatform, withTenant } from "@ros/db";
import { LOGO_FILE, jobPostingJsonLd, refFor } from "@ros/integrations";
import { randomToken } from "@ros/db";
import { UPLOAD_GRANT_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, checkUploadIntent, quarantineKey } from "../uploads";
import { clientIp, type Vars } from "../middleware/session";
import type { Container } from "../container";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { createApplication, markUploadUsed, queueLinkRequest, uploadAlreadyUsed, type ResumeInput } from "../services/applications";
import { confirmRepeat, conversationEdit, conversationLater, conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, conversationWithdraw, findConversation, repeatConfirmationView, startApplyConversation, type ConversationRef, type ConversationView, type RepeatConfirmationView, type TurnAction } from "../services/apply-conversation";
import { lateApplicationAllowed, sealFormOpened } from "../services/closing-date";
import { approvedAbout, contactLineFor, logoPublicPath, logoPublicUrl, logoResponse, profileOf } from "../services/company-settings-profile";
import { applyFlowOf, type ApplyFlowView } from "../services/job-preview";
import { jobUrls } from "../services/job-urls";
import { exitCleanup } from "../services/exit-cleanup";
import { optBackIntoTalentPool, optOutOfTalentPool } from "../services/talent-pool";
import { descriptionExcerpt } from "./description";
import { Icon } from "./icons";
import { JobFacts, payShown, publicPay, roleValidThrough } from "./job-facts";
import { ApplyFormPage, CompanyLine, HelpLine, JobPage, NO_RESUME_QUESTIONS, keptSentence, noResumeAnswersFrom, noticeVersionsFor, type ApplyFormProps, type ApplyFormState, type JobPageCompany, type JobPageRole } from "./job-page";
import { Layout } from "./layout";
import { clearApplicationSource, resolveApplicationSource } from "./links";
import { MessageThread, THREAD_CSS, threadOf, toldWording } from "./thread";
import { PERSON_BY_EMAIL, PERSON_ON_THE_WEB, forTheWeb } from "./web-wording";

export const candidatePages = new Hono<Vars>();

/** The notices a public page of this job carries, for its jurisdictions and the company's own wording. */
function jobNotices(packet: RolePacket, company: Pick<typeof companies.$inferSelect, "locations" | "settings">): Notice[] {
  return jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
}

/**
 * The receipt everyone sees after sending the form (Wave 0 item 0.1): new or repeat, the page is the same, and the
 * status link only ever travels by email to the address on file. The address shown is masked and carried for a
 * short while in a sealed cookie the browser cannot read, never in the URL.
 */
export const RECEIPT_COOKIE = "ros_applied";
const RECEIPT_PURPOSE = "application-receipt";
const RECEIPT_TTL_MS = 30 * 60_000;
/**
 * `next` is what the receipt says comes next (plan Wave E): "review" (the team reviews; also the neutral answer when an
 * eligibility answer did not match, E7) or "conversation_by_email" (the month's conversations are used up, so the link
 * comes by email once more are added, Q17). Worked out from the same inputs for a first and a repeat submission.
 */
type ReceiptNext = "review" | "conversation_by_email";
type ReceiptPayload = { v: 1; roleId: string; to: string; exp: number; next?: ReceiptNext };

/** "a***@example.com": enough for the person to recognise their own address, nothing more. */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return "the email address you gave";
  return `${e[0]}***@${e.slice(at + 1)}`;
}

function receiptPath(slug: string, roleId: string): string {
  return `/careers/${slug}/jobs/${roleId}/applied`;
}

/** Sends the browser to the receipt, with the masked address it shows. The same answer for every kind of submission. */
function toReceipt(c: Context<Vars>, job: { company: { slug: string }; role: { id: string } }, typedEmail: string, next: ReceiptNext = "review") {
  const container = c.get("container");
  const path = receiptPath(job.company.slug, job.role.id);
  const payload: ReceiptPayload = { v: 1, roleId: job.role.id, to: maskEmail(typedEmail), exp: container.engine.clock().getTime() + RECEIPT_TTL_MS, next };
  setCookie(c, RECEIPT_COOKIE, sealPayload(RECEIPT_PURPOSE, payload, container.env.SESSION_SECRET), { httpOnly: true, sameSite: "Lax", secure: container.env.NODE_ENV === "production", path, maxAge: RECEIPT_TTL_MS / 1000 });
  return c.redirect(path);
}

/**
 * The conversation's introduction says the application went through, and where its link went, the way the receipt does
 * (plan E1): the masked address that was typed rides in a sealed cookie for that one conversation's pages, never in the
 * URL. A repeat submission's conversation gets the same, so the two read alike.
 */
export const CONVERSATION_COOKIE = "ros_applied_to";
const CONVERSATION_PURPOSE = "application-conversation";
type ConversationPayload = { v: 1; token: string; to: string; exp: number };

function screenPath(token: string): string {
  return `/c/screen/${token}`;
}

/** Sends the browser from the form straight to the conversation's introduction (plan E1). */
function toConversation(c: Context<Vars>, token: string, typedEmail: string) {
  const container = c.get("container");
  const path = screenPath(token);
  const payload: ConversationPayload = { v: 1, token, to: maskEmail(typedEmail), exp: container.engine.clock().getTime() + RECEIPT_TTL_MS };
  setCookie(c, CONVERSATION_COOKIE, sealPayload(CONVERSATION_PURPOSE, payload, container.env.SESSION_SECRET), { httpOnly: true, sameSite: "Lax", secure: container.env.NODE_ENV === "production", path, maxAge: RECEIPT_TTL_MS / 1000 });
  return c.redirect(path);
}

/**
 * The "accepting applications" switch and a pause (docs/spec/20 item 16) both keep the job page up and close the form:
 * the page says so, the apply routes answer 404, and nobody already in the process is touched. A closing date (plan D7)
 * turns the same switch off at the end of its day; a form opened before then may still be sent for a while.
 */
function acceptingApplications(role: { status: string; acceptingApplications: boolean }): boolean {
  return role.status === "open" && role.acceptingApplications;
}

/** What the job page says instead of the Apply button. */
function closedMessage(role: { status: string; applicationsClosedReason?: string | null; applicationsCloseOn?: string | null }): string {
  if (role.status === "closed") return "This position is closed and no longer taking applications.";
  if (role.applicationsClosedReason === CLOSING_DATE_REASON && role.applicationsCloseOn) return `Applications for this position closed at the end of ${closingDayWords(role.applicationsCloseOn)}.`;
  return "This position is not taking new applications right now.";
}

/** Without JavaScript the résumé travels inside the form itself, which the platform refuses above a few megabytes; this cap gives that case a plain answer (D14). */
export const NO_SCRIPT_MAX_RESUME_BYTES = 4 * 1024 * 1024;

/**
 * A company's public pages (the careers page, its job pages, the apply form and its receipt) exist only once ITS has
 * confirmed the company (founder decision B7). Until then they answer exactly as a company that does not exist, so
 * nothing about an unconfirmed company is public, its JobPosting data included.
 */
async function loadPublicCompany(db: Vars["Variables"]["container"]["db"], slug: string) {
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
  return company && isCompanyVerified(company.settings) ? company : null;
}

async function loadJob(db: Vars["Variables"]["container"]["db"], slug: string, roleId: string) {
  const company = await loadPublicCompany(db, slug);
  if (!company) return null;
  const [role] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.companyId, company.id))).limit(1);
  if (!role?.currentPacketVersion) return null;
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
  if (!pv) return null;
  return { company, role, packet: pv.packet };
}
type Job = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

/**
 * What the public pages say about the company (plan D10): the text a person approved (never a draft, never the role
 * plans' own company line), our copy of the logo, and who answers before applying.
 */
function publicCompany(company: typeof companies.$inferSelect, env: Container["env"]): JobPageCompany {
  const logo = profileOf(company.settings).logo;
  return { name: company.name, slug: company.slug, about: approvedAbout(company.settings), website: company.settings.website ?? null, logoSrc: logo ? logoPublicPath(company.slug, logo) : null, contact: contactLineFor(company.settings, env) };
}

/** The logo's full address for search engines and link previews: our stored copy, else an address typed before uploads existed. */
function publicLogoUrl(company: typeof companies.$inferSelect, env: Container["env"]): string | null {
  const logo = profileOf(company.settings).logo;
  return logo ? logoPublicUrl(env, company.slug, logo) : company.settings.logoUrl ?? null;
}

function jobRoleView(role: typeof roles.$inferSelect): JobPageRole {
  const accepting = acceptingApplications(role);
  return { id: role.id, accepting, closedMessage: accepting ? null : closedMessage(role), postedOn: role.openedAt ?? role.createdAt, applyBy: accepting && role.applicationsCloseOn ? applyByLabel(role.applicationsCloseOn) : null };
}

/**
 * The careers page (plan D10): the company with its logo and the text it approved about itself, then every open job
 * with its places, work model, kind of job, pay, its first lines and its closing date; the jobs and the versions they
 * run on come in one query.
 */
candidatePages.get("/careers/:slug", async (c) => {
  const container = c.get("container");
  const company = await loadPublicCompany(container.db, c.req.param("slug"));
  if (!company) return c.notFound();
  const open = await container.db
    .select({ role: roles, packet: rolePackets.packet })
    .from(roles)
    .innerJoin(rolePackets, and(eq(rolePackets.roleId, roles.id), eq(rolePackets.version, roles.currentPacketVersion)))
    .where(and(eq(roles.companyId, company.id), eq(roles.status, "open")))
    .orderBy(desc(roles.openedAt));
  const view = publicCompany(company, container.env);
  const intro = company.settings.careersPage?.intro ?? "We respond to every applicant and keep the process short.";
  const summary = `${open.length ? `${open.length} open ${open.length === 1 ? "job" : "jobs"} at ${company.name}.` : `Jobs at ${company.name}.`} ${view.about ?? intro}`.slice(0, 300);
  return c.html(
    <Layout title={`Careers at ${company.name}`} wide description={summary} share={{ title: `Careers at ${company.name}`, description: summary, url: jobUrls(container.env, { slug: company.slug, roleId: "-" }).careers, siteName: company.name, image: publicLogoUrl(company, container.env) }}>
      <div class="careers">
        <div class="careers-head">
          <CompanyLine company={view} eyebrow="Careers" />
          <h1>Work with {company.name}</h1>
          <p class="lead">{intro}</p>
        </div>
        {view.about ? (
          <section class="card about" aria-labelledby="about-company">
            <h2 id="about-company">About {company.name}</h2>
            <p class="pre">{view.about}</p>
          </section>
        ) : null}
        <h2>Open positions</h2>
        {open.length === 0 ? <div class="card">No open positions right now. Check back soon.</div> : null}
        {open.length ? (
          <ul class="roles">
            {open.map(({ role: r, packet }) => {
              const title = packet.identity.title;
              const accepting = r.acceptingApplications;
              return (
                <li class="card role">
                  <div class="role-main">
                    <h3>{title}</h3>
                    <JobFacts packet={packet} pay={publicPay(packet, jobNotices(packet, company))} small schedule={false} />
                    <p class="excerpt">{descriptionExcerpt(packet.description.publicJobDescription)}</p>
                    {accepting ? (r.applicationsCloseOn ? <p class="meta">{applyByLabel(r.applicationsCloseOn)}</p> : null) : <p class="meta">{r.applicationsClosedReason === CLOSING_DATE_REASON && r.applicationsCloseOn ? `Applications closed at the end of ${closingDayWords(r.applicationsCloseOn)}.` : "Not taking new applications right now."}</p>}
                  </div>
                  <a class="btn secondary" href={`/careers/${company.slug}/jobs/${r.id}`}>{accepting ? "View and apply" : "View details"}<span class="sr-only">: {title}</span><Icon name="arrow-right" /></a>
                </li>
              );
            })}
          </ul>
        ) : null}
        <HelpLine contact={view.contact} />
        <p class="foot"><a href="/c/link-request">Already applied? Get your application link again</a> · <a href="/privacy">How we handle your information</a></p>
      </div>
    </Layout>,
  );
});

/**
 * The company's logo, from our own storage (plan D10): only the file the company has now, only once ITS has confirmed
 * the company. The name is a fresh id per upload, so the copy may be cached for good.
 */
candidatePages.get("/careers/:slug/logo/:file", async (c) => {
  const container = c.get("container");
  const file = c.req.param("file");
  if (!LOGO_FILE.test(file)) return c.notFound();
  const company = await loadPublicCompany(container.db, c.req.param("slug"));
  const logo = company ? profileOf(company.settings).logo : undefined;
  if (!logo || logo.file !== file) return c.notFound();
  const bytes = await container.integrations.storage.get(logo.key);
  if (!bytes) return c.notFound();
  return logoResponse(bytes, logo.contentType, "public, max-age=31536000, immutable");
});

candidatePages.get("/careers/:slug/jobs/:roleId", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const { company, role, packet } = job;
  const urls = jobUrls(container.env, { slug: company.slug, roleId: role.id });
  const allNotices = jobNotices(packet, company);
  const logoUrl = publicLogoUrl(company, container.env);
  // The JobPosting block stays on paused and closed pages (docs/spec/20 item 4). validThrough is a real date only: the
  // closing day, the day the role stopped taking applications, or its closing date; an open role with none carries none.
  const jsonLd = jobPostingJsonLd({
    roleId: role.id,
    companyName: company.name,
    companySlug: company.slug,
    packet,
    jobUrl: urls.job,
    applyUrl: urls.apply,
    datePosted: (role.openedAt ?? role.createdAt).slice(0, 10),
    validThrough: roleValidThrough(role) ?? null,
    showPay: payShown(packet, allNotices),
    companyWebsite: company.settings.website ?? null,
    companyLogoUrl: logoUrl,
  });
  const excerpt = descriptionExcerpt(packet.description.publicJobDescription, 155);
  return c.html(
    <JobPage
      packet={packet}
      company={publicCompany(company, container.env)}
      role={jobRoleView(role)}
      notices={allNotices}
      smsEnabled={container.env.SMS_ENABLED}
      flow={await jobFlow(container, job)}
      benefits={benefitsDescriptionFor(packet.compensation, company.settings)}
      links={{ careers: `/careers/${company.slug}`, apply: `/careers/${company.slug}/jobs/${role.id}/apply` }}
      jsonLd={jsonLd}
      description={excerpt}
      share={{ title: `${packet.identity.title} at ${company.name}`, description: excerpt, url: urls.job, siteName: company.name, image: logoUrl }}
    />,
  );
});

/**
 * How this job's applicants meet the screening conversation, so the job page and the form say how long applying really
 * takes (plan E8): the same rule the apply POST follows (services/apply-conversation.ts).
 */
function jobFlow(container: Container, job: Job): Promise<ApplyFlowView> {
  return withTenant(container.db, job.company.id, (tx) => applyFlowOf(tx, job.company, job.role));
}

/** Everything the apply form needs that does not change between showing it and showing it again. */
function applyFormFor(container: Container, job: Job, flow: ApplyFlowView): Omit<ApplyFormProps, "formOpened"> {
  const base = `/careers/${job.company.slug}/jobs/${job.role.id}`;
  return {
    company: { slug: job.company.slug, name: job.company.name, contact: contactLineFor(job.company.settings, container.env) },
    role: { id: job.role.id },
    packet: job.packet,
    notices: jobNotices(job.packet, job.company),
    smsEnabled: container.env.SMS_ENABLED,
    privacyEmail: container.env.PRIVACY_EMAIL,
    flow,
    links: { job: base, uploadIntent: `${base}/upload-intent` },
  };
}

/**
 * Whether this submission (or upload) is taken: while the role takes applications, and for a while after its closing
 * date passed when the form was opened before it (plan D7, services/closing-date.ts). A role a person paused or switched
 * off takes nothing new.
 */
function admits(container: Container, role: Job["role"], formOpened: string | null | undefined): { ok: boolean; late: boolean } {
  if (acceptingApplications(role)) return { ok: true, late: false };
  const late = lateApplicationAllowed({ role, sealed: formOpened, secret: container.env.SESSION_SECRET, now: container.engine.clock() });
  return { ok: late, late };
}

candidatePages.get("/careers/:slug/jobs/:roleId/apply", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job || !acceptingApplications(job.role)) return c.notFound();
  // Funnel measurement without identity (correction 14): a random per-visit reference, no candidate data, no client script; the source comes from the tracked-link cookie when there is one.
  void container.integrations.analytics.capture({ name: "application_started", subjectRef: randomToken(12), companyRef: refFor(job.company.id, container.integrations.analyticsSalt), at: new Date().toISOString(), properties: { source: resolveApplicationSource(c, job.role.id).source } }).catch(() => undefined);
  return c.html(<ApplyFormPage {...applyFormFor(container, job, await jobFlow(container, job))} formOpened={sealFormOpened(container.env.SESSION_SECRET, job.role.id, container.engine.clock())} />);
});

/**
 * Step one of a direct upload: the browser describes the file (name, size, type) and receives a short-lived
 * authorization to put exactly one object under a quarantine key, plus the sealed grant the form will carry.
 */
candidatePages.post("/careers/:slug/jobs/:roleId/upload-intent", rateLimit(POLICIES.apply), async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  let raw: unknown = null;
  try { raw = await c.req.json(); } catch { raw = null; }
  const opened = (raw as { formOpened?: unknown } | null)?.formOpened;
  if (!job || !admits(container, job.role, typeof opened === "string" ? opened : null).ok) return c.json({ error: { code: "not_found", message: "This position is not taking new applications right now." } }, 404);
  const intent = checkUploadIntent(raw);
  if (!intent.ok) return c.json({ error: { code: "invalid_file", message: intent.error } }, 400);
  const uploadId = uuidv7();
  const key = quarantineKey(job.company.id, job.role.id, uploadId, intent.extension);
  const now = container.engine.clock();
  const upload = await container.integrations.storage.createUploadUrl(key, { contentType: intent.mime, expiresSeconds: UPLOAD_URL_TTL_SECONDS });
  const grant = container.uploadGrants.seal({ v: 1, companyId: job.company.id, roleId: job.role.id, uploadId, key, filename: intent.filename, mime: intent.mime, size: intent.size, exp: Math.floor(now.getTime() / 1000) + UPLOAD_GRANT_TTL_SECONDS });
  await withTenant(container.db, job.company.id, (tx) => emit(tx, { type: "document.upload_authorized", companyId: job.company.id, actor: { kind: "candidate", id: "applicant" }, subject: { type: "role", id: job.role.id }, payload: { uploadId, extension: intent.extension, sizeBytes: intent.size } }));
  return c.json({ uploadId, url: upload.url, method: upload.method, headers: upload.headers, grant, expiresAt: upload.expiresAt, maxBytes: MAX_RESUME_BYTES });
});

candidatePages.post("/careers/:slug/jobs/:roleId/apply", rateLimit(POLICIES.apply), async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = await c.req.parseBody({ all: true });
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : Array.isArray(body[k]) ? String((body[k] as string[])[0]) : "");
  const admitted = admits(container, job.role, str("formOpened"));
  if (!admitted.ok) return c.notFound();
  const { company, role, packet } = job;
  const smsEnabled = container.env.SMS_ENABLED;
  const form = applyFormFor(container, job, await jobFlow(container, job));
  // A form shown again keeps the moment it was first opened, so the closing date's grace still applies to it.
  const formOpened = str("formOpened") || sealFormOpened(container.env.SESSION_SECRET, role.id, container.engine.clock());
  // The versions recorded as shown are the server's own, computed from the same inputs as the render; a browser cannot claim a different set.
  const noticeVersionsShown = noticeVersionsFor(form.notices, smsEnabled);
  const eligibilityAnswers: Record<string, unknown> = {};
  const answers: Record<string, string | string[]> = {};
  for (const rule of packet.requirements.eligibility) {
    const raw = body[`elig_${rule.key}`];
    if (Array.isArray(raw)) eligibilityAnswers[rule.key] = answers[rule.key] = raw.filter((x): x is string => typeof x === "string");
    else if (typeof raw === "string" && raw !== "") eligibilityAnswers[rule.key] = answers[rule.key] = raw;
  }
  const acknowledged = str("acknowledged") === "yes";
  // While texting is off (decision M2) the checkbox is not on the page, and a posted value is ignored: no consent is recorded and no event is emitted.
  const smsConsent = smsEnabled && str("smsConsent") === "yes";
  const values: Record<string, string> = { firstName: str("firstName"), lastName: str("lastName"), email: str("email"), phone: str("phone"), locationText: str("locationText"), noResume: str("noResume") };
  for (const q of NO_RESUME_QUESTIONS) values[`nr_${q.key}`] = str(`nr_${q.key}`);
  // The four short questions (plan D10), and the one box an older page may still send; stored with the summary every reader uses.
  const noResumeAnswers = noResumeAnswersFrom({ ...Object.fromEntries(NO_RESUME_QUESTIONS.map((q) => [q.key, values[`nr_${q.key}`]])), noResume: values.noResume });
  const state = (missing: string[] = [], resume: Pick<ApplyFormState, "resume" | "resumeLost"> = { resume: null, resumeLost: false }): Partial<ApplyFormState> => ({ values, answers, acknowledged, smsConsent, missing, ...resume });
  const again = (error: string, missing: string[] = [], resume?: Pick<ApplyFormState, "resume" | "resumeLost">) => c.html(<ApplyFormPage {...form} formOpened={formOpened} error={error} state={state(missing, resume)} />, 400);
  // Honeypot: a filled hidden field gets exactly the receipt a person gets, and nothing is recorded.
  if (str("website")) return toReceipt(c, job, values.email);
  const parsed = ApplyRequest.safeParse({
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone || undefined,
    locationText: values.locationText || undefined,
    smsConsent,
    answers: eligibilityAnswers,
    noResumeAnswers,
    noticeVersionsShown,
    acknowledged,
  });
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
    const onlyAcknowledgment = missing.length === 1 && missing[0] === "acknowledged";
    // A resume the browser already uploaded stays attached: its grant, still valid for this company and role, goes back into
    // the form. A file posted inside the form (or a grant that no longer opens) cannot be put back, and the page says so.
    const grantBack = str("uploadGrant");
    const opened = grantBack ? container.uploadGrants.open(grantBack, container.engine.clock()) : null;
    const keptResume = opened && opened.companyId === company.id && opened.roleId === role.id ? { grant: grantBack, filename: opened.filename } : null;
    const posted = body.resume;
    const postedFile = !!posted && typeof posted === "object" && "size" in posted && (posted as File).size > 0;
    const resumeLost = !keptResume && (postedFile || !!grantBack);
    const still = keptSentence(resumeLost);
    return again(onlyAcknowledgment ? `One more step: please confirm you have read the notice at the bottom of the form. ${still}` : `Please check the highlighted fields: a first name, last name, a valid email, and the confirmation at the bottom of the form are required. ${still}`, missing, { resume: keptResume, resumeLost });
  }

  let resume: ResumeInput | null = null;
  let usedUploadId: string | null = null;
  const grantToken = str("uploadGrant");
  if (grantToken) {
    // The browser uploaded straight to storage; the grant names the object. It must be for this company and role.
    const grant = container.uploadGrants.open(grantToken, container.engine.clock());
    const expired = "Your uploaded resume could not be attached (the upload expired). Please attach the file again.";
    if (!grant || grant.companyId !== company.id || grant.roleId !== role.id) return again(expired);
    // One submission per grant, refused before the file is looked at (services/applications.ts, uploadAlreadyUsed).
    if (await withTenant(container.db, company.id, (tx) => uploadAlreadyUsed(tx, { roleId: role.id, uploadId: grant.uploadId }))) return again(expired);
    const head = await container.integrations.storage.head(grant.key);
    if (!head || head.size === 0) return again("Your uploaded resume did not arrive. Please attach the file again.");
    if (head.size > MAX_RESUME_BYTES) {
      await container.integrations.storage.delete(grant.key);
      return again("Resume files must be under 8 MB.");
    }
    resume = { kind: "stored", filename: grant.filename, mime: grant.mime, storageKey: grant.key, sizeBytes: head.size, via: "direct" };
    usedUploadId = grant.uploadId;
  } else {
    const file = body.resume;
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      if (f.size > 0) {
        // The form carried the file itself (no JavaScript, or the direct upload failed): the platform refuses large bodies before this code runs, so the friendly limit is lower (D14).
        if (f.size > NO_SCRIPT_MAX_RESUME_BYTES) return again(f.size > MAX_RESUME_BYTES ? "Resume files must be under 8 MB." : "Files over 4 MB can only be sent by the direct upload, which needs JavaScript. Please choose a smaller file, or try again with JavaScript turned on.");
        const bytes = new Uint8Array(await f.arrayBuffer());
        const look = inspectResumeFile(bytes, { mime: f.type, filename: f.name });
        if (!look.ok) return again(look.reason === "unsupported_type" || look.reason === "type_mismatch" ? "Please upload a PDF, Word (.docx), or text file." : `That file cannot be used: ${look.detail}.`);
        resume = { kind: "bytes", filename: f.name, mime: look.mime, bytes, via: "server" };
      }
    }
  }
  if (!resume && !parsed.data.noResumeAnswers) return again("Upload a resume, or answer at least one of the four short questions about your work.", ["noResume"]);

  // The consent record carries the address the trusted proxy reports, never one the client wrote into the header.
  const ip = clientIp(c);
  // The source comes from the tracked-link cookie when it names this role (docs/spec/20 items 8 and 19); the token itself is never stored.
  const origin = resolveApplicationSource(c, role.id);
  // A new application and a repeat one end on the same pages (Wave 0 item 0.1, plan E1): the page never shows or links to
  // an existing application, so typing someone else's address reveals nothing and changes nothing on their record. Where
  // the role takes the conversation in the same visit, both go on to its introduction: a repeat's is a detached copy that
  // touches nothing until the owner of the address on file confirms it (services/apply-conversation.ts).
  const next = await withTenant(container.db, company.id, async (tx) => {
    if (usedUploadId) await markUploadUsed(tx, { companyId: company.id, roleId: role.id, uploadId: usedUploadId });
    const created = await createApplication(tx, container, {
      companyId: company.id,
      roleId: role.id,
      source: origin.source,
      sourceDetail: origin.sourceDetail,
      linkId: origin.linkId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      locationText: parsed.data.locationText ?? null,
      smsConsent: parsed.data.smsConsent,
      consentSource: "careers_page_apply",
      noticeVersionsShown,
      acknowledgment: { at: container.engine.clock().toISOString(), noticeVersions: noticeVersionsShown, ...(ip ? { ip } : {}) },
      eligibilityAnswers,
      noResumeAnswers: parsed.data.noResumeAnswers,
      resume,
      ip,
    }, { kind: "candidate", id: "applicant" }, { closingGrace: admitted.late });
    // The conversation offered in the same visit (plan E1), or the receipt: decided in this transaction, from what was typed.
    return startApplyConversation(tx, container, { ...created, role, company, packet, typedFirstName: parsed.data.firstName, eligibilityAnswers });
  });
  await container.kick();
  clearApplicationSource(c);
  if (next.kind === "conversation") return toConversation(c, next.token, parsed.data.email);
  // An answer that did not match an eligibility question gets the neutral receipt (E7): no conversation, nothing said about why.
  return toReceipt(c, job, parsed.data.email, next.reason === "conversation_by_email" ? "conversation_by_email" : "review");
});

/**
 * The receipt (Wave 0 item 0.1). Identical for a first application, a repeat one and a bot; it never names a status
 * link. When the month's conversations are used up (Q17), it says the conversation's link comes by email; an answer that
 * did not match an eligibility question reads like any other application (E7).
 */
function Receipt(props: { company: { slug: string; name: string }; role: { id: string }; packet: RolePacket; to: string | null; next: ReceiptNext }) {
  return (
    <Layout title="Check your email">
      <p class="eyebrow"><a href={`/careers/${props.company.slug}/jobs/${props.role.id}`}>{props.packet.identity.title}</a> · {props.company.name}</p>
      <h1>Thanks for applying</h1>
      <div class="card" role="status">
        {/* True for a first application and a repeat alike: a repeat's reminder goes at most once a day, so it may be in an earlier email. */}
        <p><strong>Check your email.</strong> Your own link to this application goes to {props.to ?? "the email address you gave"}. If you applied for this job before, look in our earlier emails too: we send the link again at most once a day.</p>
        <p>Keep that email. The link is how you check where things stand, withdraw, or ask about your information. There is no account or password.</p>
      </div>
      <h2>What happens next</h2>
      <ol class="steps">
        {props.next === "conversation_by_email" ? <li>We email you a link to a short written conversation with {props.company.name}'s AI assistant (about {props.packet.screening.maxMinutes} minutes). Answer it whenever suits you, or ask for a person instead.</li> : null}
        <li>The hiring team at {props.company.name} reviews your application. People make every decision.</li>
        <li>You hear from us by email either way.</li>
      </ol>
      <h2>No email?</h2>
      <p>It can take a few minutes. Look in your spam or promotions folder too. If it still has not arrived, we can send your link again.</p>
      <a class="btn secondary" href="/c/link-request">Send my link again</a>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

candidatePages.get("/careers/:slug/jobs/:roleId/applied", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const sealed = openPayload<ReceiptPayload>(RECEIPT_PURPOSE, getCookie(c, RECEIPT_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  const mine = sealed?.v === 1 && sealed.roleId === job.role.id;
  const to = mine && typeof sealed.to === "string" ? sealed.to : null;
  c.header("Cache-Control", "no-store");
  return c.html(<Receipt company={job.company} role={job.role} packet={job.packet} to={to} next={mine && sealed.next === "conversation_by_email" ? "conversation_by_email" : "review"} />);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* "Lost your link?" (Wave 0 item 0.1): the status link goes again to the address on file, never to the page.   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The form's one field, checked here (the shared contracts stay as they are in this wave). */
const LinkRequestForm = z.object({ email: z.email().max(254) });

function LinkRequestPage(props: { error?: string; email?: string }) {
  return (
    <Layout title="Get your application link again">
      <p class="eyebrow">Your application</p>
      <h1>Lost your link?</h1>
      <p class="lead">Type the email address you applied with. If we have an application from that address, we email your link to it. We only ever send it to that address, never to this page.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" action="/c/link-request" class="card">
        <div style="position:absolute;left:-10000px" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex={-1} autocomplete="off" /></div>
        <label for="email" class="flush">Your email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={props.email ?? ""} />
        <button class="btn" type="submit">Email me my link</button>
      </form>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** What every request answers, whether or not the address is known: only the mailbox learns that. */
function LinkRequestSent() {
  return (
    <Layout title="Check your email">
      <p class="eyebrow">Your application</p>
      <h1>Check your email</h1>
      <div class="card" role="status">
        <p><strong>If we have an application from that address, your link is on its way.</strong></p>
        <p>It can take a few minutes; look in your spam or promotions folder too. To protect your privacy, this page looks the same whether or not we found anything.</p>
      </div>
      <p class="foot">Still nothing? You may have applied with a different address. <a href="/c/link-request">Try another address</a>.</p>
    </Layout>
  );
}

candidatePages.get("/c/link-request", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(c.req.query("sent") === "1" ? <LinkRequestSent /> : <LinkRequestPage />);
});

candidatePages.post("/c/link-request", rateLimit(POLICIES.linkRequest), async (c) => {
  const container = c.get("container");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  // the honeypot is answered like everyone else and sends nothing
  if (str("website")) return c.redirect("/c/link-request?sent=1", 303);
  const parsed = LinkRequestForm.safeParse({ email: str("email").trim() });
  if (!parsed.success) return c.html(<LinkRequestPage error="Please check the email address and send it again." email={str("email")} />, 400);
  // One queued job for every address, known or not; the worker looks it up (in production the kick does nothing here).
  await queueLinkRequest(container, parsed.data.email);
  await container.kick();
  return c.redirect("/c/link-request?sent=1", 303);
});

/**
 * The candidate's four steps (plan A1), drawn as a quiet bar under each word; the current one is announced as such.
 * The messages about the application read as a conversation (plan G7), in the screening conversation's look.
 */
export const STATUS_CSS = `
.track { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 20px 0 4px; padding: 0; list-style: none; }
.track li { position: relative; padding-top: 14px; color: var(--ink-3); font-size: 14px; font-weight: 600; line-height: 1.3; }
.track li::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 6px; border-radius: var(--r-pill); background: var(--surface-2); }
.track li.done::before, .track li.current::before { background: var(--ink); }
.track li.current { color: var(--ink); }
${THREAD_CSS}`;

/**
 * What the candidate may see of a decision (founder decision B6): a decline or a move to the talent pool shows only once
 * they were told. Until then the page stands where they last saw it: the stage the decision was made from, and the
 * date that stage began. Read off the stage history, never off marks or holds, which the candidate never sees.
 */
async function visibleStage(container: Container, app: typeof applications.$inferSelect): Promise<{ hidden: boolean; before: ApplicationStage | null; since: string }> {
  if (!DECISION_STAGES.includes(app.stage) || decisionTold(app.toldState)) return { hidden: false, before: null, since: app.stageChangedAt };
  const moves = await withTenant(container.db, app.companyId, (tx) => tx.select({ payload: events.payload, at: events.occurredAt }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id), eq(events.type, "application.stage_changed"))).orderBy(asc(events.id)));
  let i = moves.length - 1;
  while (i >= 0 && DECISION_STAGES.includes(moves[i].payload.to as ApplicationStage)) i -= 1;
  const before = i >= 0 ? (moves[i].payload.to as ApplicationStage) : ((moves[0]?.payload.from as ApplicationStage | undefined) ?? null);
  return { hidden: true, before, since: i >= 0 ? moves[i].at : app.createdAt };
}

/**
 * DRAFT WORDING PENDING COUNSEL (docs/spec/11-counsel-register.md item 23), except the standard decline line and the
 * plain talent-pool line, the release-1 wording. Each line restates a `DECISION_SENTENCE` wording in
 * `packages/agents/src/coordinator.ts` in the page's own words; change both together.
 *
 * A decision in the words of the message that told it (plan G6): the closing message of a closed role (Q30), a filled
 * position, a decline after an interview or on an eligibility answer. Any other approved wording, and a decision a
 * person told them themselves, read the standard way. Never a reason beyond the eligibility answer, which the candidate
 * can correct, and never before they were told (founder decision B6).
 */
function decisionLine(input: { stage: ApplicationStage; wording: DecisionWording | null; poolOptOut: boolean; companyName: string }): string {
  const { wording, poolOptOut, companyName } = input;
  if (input.stage === "talent_pool") {
    const pool = poolOptOut ? "As you asked, nobody will contact you about future openings." : "We are keeping you in mind for future openings.";
    if (wording === "role_closed") return `${companyName} has closed this position, so your application for it will not go any further. ${pool}`;
    if (wording === "position_filled") return `The position has been filled, so this role is not moving forward for you. ${pool}`;
    if (wording === "after_interview") return `Thank you for meeting the team. This role is not moving forward for you. ${pool}`;
    return `This role is not moving forward for you. ${pool}`;
  }
  const keep = poolOptOut ? "" : " We will keep you in mind for future openings unless you ask us not to.";
  if (wording === "eligibility") return `Based on your answers to the eligibility questions, this role needs something you said you do not have right now. If that has changed, or you answered in error, reply to our email and a person will take a look.${keep}`;
  if (wording === "role_closed") return `${companyName} has closed this position, so your application for it will not go any further.${keep}`;
  if (wording === "position_filled") return `The position has been filled, so your application for this role will not go any further. Thank you for applying.${keep}`;
  if (wording === "after_interview") return `Thank you for meeting the team. They have decided not to move forward with your application for this role.${keep}`;
  return poolOptOut ? "Thank you for applying. This role did not work out." : "Thank you for applying. This role did not work out, and we will keep you in mind for future openings unless you ask us not to.";
}

/** The line under the steps, in the candidate's words: what is happening now and what they can do. */
function nextLine(input: { step: CandidateStep; stage: ApplicationStage; poolOptOut: boolean; screen: { status: string } | null; interview: "booked" | "offered" | null; wording: DecisionWording | null; companyName: string }): string {
  const { step, stage, poolOptOut } = input;
  if (step === "received") return stage === "applied" ? "We are confirming your application now." : "Your application is in. We are checking the basics.";
  if (step === "under_review") {
    if (input.screen?.status === "paused") return "Your screening conversation is paused while we fix a problem on our end. Your answers so far are saved, and we will email you a link to finish.";
    if (input.screen) return input.screen.status === "in_progress" ? "Finish the short written conversation with the hiring team's AI assistant whenever you are ready. Your answers so far are saved. The link is below." : "A short written conversation with the hiring team's AI assistant is waiting for you, whenever suits you. The link is below.";
    if (stage === "screen_complete") return "Thanks for completing the screening conversation. The team is reviewing your answers.";
    return "The hiring team is reviewing your application. You will hear from them either way.";
  }
  if (step === "interview") {
    if (input.interview === "booked") return "Your interview is booked. The details are below and in your email.";
    if (input.interview === "offered") return "The team would like to interview you. Pick a time below.";
    if (stage === "interview_complete" || stage === "debrief") return "Thanks for interviewing. The team is deciding, and you will hear from them either way.";
    return "The hiring team will be in touch about next steps.";
  }
  if (stage === "hired") return "You are on the team.";
  if (stage === "accepted" || stage === "onboarding") return "Welcome aboard.";
  // "Offer made" is a record the team keeps (founder decision Q29): the offer itself comes from them, never from this page or our emails.
  if (stage === "offer_sent" || stage === "negotiation") return "The team has made you an offer. They will go through it with you directly. If you have a question, reply to any of our emails.";
  if (stage === "declined") return "You turned down the offer. Thank you for your time with us.";
  if (stage === "withdrawn") return "You withdrew this application. Thank you for your time.";
  return decisionLine({ stage, wording: input.wording, poolOptOut, companyName: input.companyName });
}

/**
 * The candidate's status page (plan A1). It speaks in four candidate steps (Received, Under review, Interview,
 * Decision), never the team's stage names: the assistant's suggestions, an eligibility hold and "finalist" read as Under
 * review. A decision shows only once the candidate was told (founder decision B6), in the words of the message that
 * told it (plan G6); until then the page stands where it was and withdrawing stays open. The messages about the
 * application read as a conversation (plan G7): only messages that actually reached them, and their own replies. A line
 * says a person decides.
 */
candidatePages.get("/c/status/:token", async (c) => {
  const container = c.get("container");
  const db = container.db;
  const [app] = await db.select().from(applications).where(eq(applications.statusToken, c.req.param("token"))).limit(1);
  if (app && (await anonymizedFor(container, app.candidateId))) return linkGone(c);
  if (!app) return c.notFound();
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const view = await visibleStage(container, app);
  const told = !view.hidden && DECISION_STAGES.includes(app.stage);
  const { thread, wording } = await withTenant(container.db, app.companyId, async (tx) => ({
    thread: await threadOf(tx, app.id),
    wording: told ? await toldWording(tx, { applicationId: app.id, decidedAt: app.stageChangedAt }) : null,
  }));
  // Nothing about a private decision shows, and nothing it closed is offered (its screens and interviews were cancelled with it).
  // A conversation paused while the assistant is down (plan E5) is mentioned, without a link: an email brings it back.
  const latestScreen = view.hidden ? undefined : (await db.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt)).limit(1))[0];
  const openScreen_ = latestScreen && ["invited", "reminded", "in_progress"].includes(latestScreen.status) ? latestScreen : undefined;
  const pausedScreen = latestScreen?.status === "paused" ? latestScreen : undefined;
  const iv = view.hidden ? undefined : (await db.select().from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt)).limit(1))[0];
  const offered = !!iv && iv.status === "scheduling" && !!iv.scheduleToken && iv.offeredSlots.length > 0;
  const booked = !!iv && iv.status === "scheduled" && !!iv.startsAt && !!iv.scheduleToken && Date.parse(iv.endsAt ?? iv.startsAt) > Date.now();
  const ivTz = iv?.schedulingWindow.candidateTimezone ?? cand?.location?.timezone ?? company?.timezone ?? "America/Los_Angeles";
  // What to prepare (D15): the purpose of the booked round, from the packet version this application runs on.
  const prepare = booked ? await withTenant(container.db, app.companyId, async (tx) => (await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1))[0]?.packet.interviews.plan.find((r) => r.key === iv!.roundKey)?.purpose ?? null) : null;
  const smsEnabled = container.env.SMS_ENABLED;
  const smsOn = !!cand?.consent.sms?.granted && !cand?.preferences.smsOptOut;
  const poolOptOut = !!cand?.preferences.talentPoolOptOut;
  const shownStage = view.hidden ? view.before ?? "triaged" : app.stage;
  // Times a person approved and offered are an interview to the candidate, whatever the team's own stage says.
  const baseStep = candidateStep(app.stage, app.toldState, view.before);
  const step: CandidateStep = baseStep === "under_review" && (offered || booked) ? "interview" : baseStep;
  const steps = CandidateStep.options;
  // "Don't keep me for future roles", from the decision message's link (#future-roles) or the button: it says it was saved.
  const pool = c.req.query("pool");
  const poolSaved = (pool === "out" && poolOptOut) || (pool === "in" && !poolOptOut);
  return c.html(
    <Layout title={`Your application at ${company?.name ?? ""}`} extraCss={STATUS_CSS}>
      <p class="eyebrow">{company?.name ? `${company.name} · ` : ""}Your application</p>
      <h1>{role?.title}</h1>
      <ol class="track" aria-label="Where your application is">
        {steps.map((s, i) => <li class={s === step ? "current" : i < steps.indexOf(step) ? "done" : undefined} aria-current={s === step ? "step" : undefined}>{CANDIDATE_STEP_LABEL[s]}</li>)}
      </ol>
      <div class="card status">
        <div><span>Status</span><strong>{CANDIDATE_STEP_LABEL[step]}</strong></div>
        <div><span>Applied</span><span>{new Date(app.createdAt).toLocaleDateString()}</span></div>
        <div><span>Last update</span><span>{new Date(view.since).toLocaleDateString()}</span></div>
      </div>
      <h2>What happens next</h2>
      <p>{nextLine({ step, stage: shownStage, poolOptOut, screen: openScreen_ ?? pausedScreen ?? null, interview: booked ? "booked" : offered ? "offered" : null, wording, companyName: company?.name ?? "The company" })}</p>
      {/* The choice the decision message points to (Q30), one click away from the decision itself. */}
      {told && !poolOptOut ? <p>Would you rather we did not keep your details for future roles? <a href="#future-roles">Say so below</a>; it takes one click.</p> : null}
      <p class="meta">People on the hiring team at {company?.name ?? "the company"} make every decision about your application. An AI assistant reads applications and runs the screening conversation for them; who is interviewed, hired or turned down is always a person's decision.</p>
      {openScreen_ ? <a class="btn" href={`/c/screen/${openScreen_.token}`}>{openScreen_.status === "in_progress" ? "Continue the screening conversation" : "Start the screening conversation"}</a> : null}
      {offered ? <div class="card"><strong>Pick a time for your {iv!.title.toLowerCase()}.</strong><p>{company?.name} would like to interview you.</p><a class="btn" href={`/c/schedule/${iv!.scheduleToken}`}><Icon name="calendar" />Choose a time</a></div> : null}
      {booked ? <div class="card"><strong>Your interview: {iv!.title}</strong><p>{new Intl.DateTimeFormat("en-US", { timeZone: ivTz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iv!.startsAt!))}{iv!.meetingUrl ? <span> · <a href={iv!.meetingUrl}>Join link</a></span> : null}</p>{prepare ? <p><strong>What to prepare:</strong> {prepare} Bring examples from your own work, and any questions you have for the team.</p> : null}<p><a href={`/c/schedule/${iv!.scheduleToken}/confirmed`}>Details, calendar file, reschedule or cancel</a></p></div> : null}
      {c.req.query("withdrawn") === "1" ? <div class="card" role="status"><strong>Your application is withdrawn.</strong><p>Thank you for your time. If you have a question, reply to any of our emails.</p></div> : null}
      <h2>Your choices</h2>
      {smsEnabled || smsOn ? (
        <div class="card">
          <p><strong>Text messages:</strong> {smsOn ? "on" : "off"}. {cand?.phone || !smsEnabled ? "" : "Add a mobile number by replying to our email to receive texts."}</p>
          {cand?.phone && (smsOn || smsEnabled) ? (
            <form method="post" action={`/c/status/${app.statusToken}/sms`}>
              <input type="hidden" name="pref" value={smsOn ? "off" : "on"} />
              <button class="btn secondary" type="submit">{smsOn ? "Stop text messages" : "Allow text messages"}</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {/* Open to anyone still in the process, and to anyone whose decision they have not been told (plan A1). */}
      {mayWithdraw(app.stage, app.toldState) ? (
        <form method="post" action={`/c/status/${app.statusToken}/withdraw`} class="card">
          <p><strong>No longer interested?</strong> One click withdraws your application; we will confirm by email and keep your information only as long as the law requires.</p>
          <label class="check"><input type="checkbox" name="confirm" value="yes" required /> Yes, withdraw my application.</label>
          <button class="btn secondary" type="submit">Withdraw my application</button>
        </form>
      ) : null}
      {/* Wave 0 item 0.11: the talent-pool choice is one click either way, and it only ever affects future roles. The
          decision and closing messages link straight here (#future-roles, Q30). */}
      {poolOptOut ? (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card" id="future-roles">
          {poolSaved ? <p role="status"><strong>Saved.</strong></p> : null}
          <p><strong>Future roles:</strong> you asked us not to keep your details for future roles, so nobody will contact you about other openings at {company?.name}.</p>
          <input type="hidden" name="pref" value="in" />
          <button class="btn secondary" type="submit">Keep me for future roles again</button>
        </form>
      ) : (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card" id="future-roles">
          {poolSaved ? <p role="status"><strong>Saved.</strong></p> : null}
          <p><strong>Future roles:</strong> {company?.name} may keep your details to tell you about other openings later. This does not change your current application.</p>
          <button class="btn secondary" type="submit">Don't keep me for future roles</button>
        </form>
      )}
      <MessageThread messages={thread.messages} more={thread.more} companyName={company?.name ?? "The hiring team"} timeZone={cand?.location?.timezone ?? company?.timezone ?? "America/Los_Angeles"} />
      <h2>Need something?</h2>
      <p>Reply to any of our emails with HUMAN to reach a person, or use the form below. To request, correct, or delete your information you can also email <a href={`mailto:${c.get("container").env.PRIVACY_EMAIL}`}>{c.get("container").env.PRIVACY_EMAIL}</a>; see <a href="/privacy">how we handle your information</a>.</p>
      {c.req.query("request") ? <div class="card" role="status"><strong>We have your request.</strong><p>A confirmation with the completion date is on its way to {cand?.email ?? "your email"}. Reference {c.req.query("request")}.</p></div> : null}
      <h2>Your information</h2>
      <form method="post" action={`/c/status/${app.statusToken}/privacy`} class="card">
        <label for="pk" class="flush">What would you like?</label>
        <select id="pk" name="kind" required>
          <option value="access">Send me a copy of my information</option>
          <option value="correct">Correct something in my information</option>
          <option value="delete">Delete my information</option>
          <option value="human_review">Have a person review my application</option>
        </select>
        <label for="pd">Details (optional)</label>
        <textarea id="pd" name="details" rows={3} maxlength={2000} placeholder="For example: my phone number is wrong, it should be ..."></textarea>
        <p class="notice">Requests made from this page are verified by the link itself. We confirm receipt and completion by email. Deleting keeps only what the law requires, without your name or contact details. A person handles every request; nothing is decided by software.</p>
        <button class="btn secondary" type="submit">Send request</button>
      </form>
    </Layout>,
  );
});

candidatePages.get("/privacy", async (c) => {
  const n = noticesFor(["*"]).find((x) => x.key === "privacy");
  const privacyEmail = c.get("container").env.PRIVACY_EMAIL;
  const smsEnabled = c.get("container").env.SMS_ENABLED;
  return c.html(
    <Layout title="How we handle your information">
      <p class="eyebrow">Privacy</p>
      <h1>How we handle your information</h1>
      <p>{n?.text}</p>
      {/* The apply form's "Who can see it" points here (docs/readiness/20 section D, item 6): every kind of service provider that touches an application, and what each one does. */}
      <h2 id="who-can-see">Who can see your information</h2>
      <ul class="steps">
        <li>The hiring team at the company you applied to. People there make every hiring decision.</li>
        <li>An Identified Talent Solutions recruiter, only if the company brings one in to help. Their access is limited to what they were brought in for, and every access is recorded.</li>
        <li>The companies that run this service for us, each only for its own job:
          <ul>
            <li>Hosting: runs this website and the work behind it.</li>
            <li>Database and file storage: keeps your application and your resume, privately.</li>
            <li>Email delivery: sends the emails about your application and receives your replies.</li>
            <li>An AI service: reads applications and screening answers to help organize and summarize them for the hiring team. It does not decide anything.</li>
            {smsEnabled ? <li>Text messages: sends and receives texts, only if you agreed to them.</li> : null}
            <li>Calendars (Google or Microsoft): only the interviewers' own calendars, to book an interview time with you.</li>
          </ul>
        </li>
      </ul>
      <p>These companies may use your information only to provide that service to us. We do not sell your information.</p>
      <h2>Your choices</h2>
      <ul class="steps">
        <li>Ask what we hold about you, correct it, or delete it: <a href="/c/privacy-request">use the request form</a> with the address you applied with (we confirm it is you by email), or write to <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> from that address. A person records the request, confirms receipt within one business day, and completes it within the legal deadline.</li>
        <li>Stop text messages any time by replying STOP.</li>
        <li>Talk to a person instead of the AI assistant: press "I'd rather talk to a person" on the conversation's page, or reply HUMAN to any of our emails.</li>
        <li>Ask not to be kept for future roles: use the button on your status page, or reply "no thanks" to any of our emails.</li>
        <li>Lost the link to your status page? <a href="/c/link-request">We can email it to you again</a>, only ever to the address you applied with.</li>
      </ul>
      <h2>Automated tools</h2>
      <p>{noticesFor(["*"]).find((x) => x.key === "ai_use")?.text}</p>
      <a class="btn" href="/c/privacy-request">Request, correct or delete my information</a>
    </Layout>,
  );
});

/* ------------------------------------------------------------------------------------------------------------ */
/* The screening conversation (plan Wave E): server-rendered, no JavaScript needed, one question at a time.      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The conversation's own styles, on top of the page stylesheet: the line on top of every page saying it is the
 * company's AI assistant, the question in large type, the assistant's messages on the left in a sunken box and the
 * candidate's own in near-black on the right (shared with the status page's messages, thread.tsx), a thin progress bar (a native progress element, so no inline style), the
 * tap answers, the quiet actions (skip, a person, later) and the "check your answers" list. Buttons and their secondary
 * look come from the page stylesheet, like every other candidate page.
 */
export const SCREEN_CSS = `
.ai-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 22px; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--r-control); background: var(--surface-2); color: var(--ink-2); font-size: 14px; line-height: 1.45; }
.ai-tag { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: var(--r-pill); background: var(--ink); color: var(--ground); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; }
h1.question { margin: 12px 0 18px; font-size: 28px; line-height: 1.22; }
.lead-in { margin: 20px 0 0; color: var(--ink-2); }
${THREAD_CSS}
.progress { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; color: var(--ink-3); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.progress label { flex: none; margin: 0; color: inherit; font-size: inherit; font-weight: inherit; }
.progress progress { flex: 1; min-width: 0; height: 6px; overflow: hidden; border: 0; border-radius: var(--r-pill); background: var(--surface-2); color: var(--ink); -webkit-appearance: none; appearance: none; }
.progress progress::-webkit-progress-bar { border-radius: var(--r-pill); background: var(--surface-2); }
.progress progress::-webkit-progress-value { border-radius: var(--r-pill); background: var(--ink); }
.progress progress::-moz-progress-bar { border-radius: var(--r-pill); background: var(--ink); }
details.earlier, details.own-words { margin: 18px 0 0; }
details.earlier > summary, details.own-words > summary { color: var(--ink-2); font-size: 15px; font-weight: 600; cursor: pointer; }
.days { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0 8px; }
.pay-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.link-action { display: inline-flex; align-items: center; min-height: 44px; padding: 0; border: 0; background: none; color: var(--ink-2); font: 600 15px/1.3 var(--ui); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; cursor: pointer; }
.link-action:hover { color: var(--ink); text-decoration-thickness: 2px; }
.aside-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0 24px; margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); }
.aside-actions > form { display: contents; }
.paths { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin: 20px 0; }
.paths > .card { display: flex; flex-direction: column; margin: 0; }
.paths > .card > h2 { margin-top: 0; }
.paths > .card > form { margin-top: auto; }
.answers { display: grid; gap: 12px; margin: 20px 0; padding: 0; list-style: none; }
.answer { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--ground); }
.answer-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.answer-q { margin: 0; color: var(--ink); font-weight: 600; }
.answer > p { margin: 8px 0 0; }
.answer > a { display: inline-block; margin-top: 8px; font-weight: 600; }
.pill { display: inline-flex; align-items: center; padding: 2px 10px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 600; }
@media (max-width: 600px) { h1.question { font-size: 23px; } }
`;

/**
 * The conversation a link opens (a screen, or a repeat submission's detached copy; services/apply-conversation.ts), and
 * whether the person behind it had their information deleted, in which case the link is dead (docs/readiness/14).
 */
async function openConversation(container: Container, token: string): Promise<{ ref: ConversationRef; gone: boolean } | null> {
  const ref = await findConversation(container.db, token);
  if (!ref) return null;
  const [app] = await container.db.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, ref.applicationId)).limit(1);
  return { ref, gone: app ? await anonymizedFor(container, app.candidateId) : false };
}

/** The masked address the application's link went to, for the introduction, when this browser just sent the form. */
function appliedTo(c: Context<Vars>, token: string): string | null {
  const container = c.get("container");
  const sealed = openPayload<ConversationPayload>(CONVERSATION_PURPOSE, getCookie(c, CONVERSATION_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  return sealed?.v === 1 && sealed.token === token && typeof sealed.to === "string" ? sealed.to : null;
}

type Line = ConversationView["transcript"][number];

/** Which question this is ("Question 2 of 5"): the packet's questions asked so far, the current one included. */
function questionNumber(view: ConversationView): number {
  const asked = new Set(view.transcript.filter((t) => t.role === "assistant" && t.questionKey && t.questionKey !== WITHDRAW_CONFIRM_KEY).map((t) => t.questionKey));
  if (view.current) asked.add(view.current.key);
  return Math.max(1, Math.min(view.total, asked.size));
}

/**
 * The conversation around the current question: what came before it (folded away, one question at a time), what the
 * assistant said just before asking it ("Thanks."), and the exchange since: the candidate's own words, and any follow-up
 * that quotes them. Every packet question is asked in the packet's own words (plan E2), so the message that asked it is
 * found by those words.
 */
function aroundQuestion(view: ConversationView): { earlier: Line[]; leadIn: string | null; exchange: Line[] } {
  const t = view.transcript;
  const q = view.current;
  if (!q) return { earlier: [], leadIn: null, exchange: t };
  let at = -1;
  for (let i = t.length - 1; i >= 0 && at < 0; i--) if (t[i].role === "assistant" && t[i].content.includes(q.question)) at = i;
  if (at < 0) return { earlier: [], leadIn: null, exchange: t };
  const leadIn = t[at].content.replace(q.question, "").replace(/\s*Next:\s*$/i, "").trim();
  return { earlier: t.slice(0, at), leadIn: leadIn || null, exchange: t.slice(at + 1) };
}

/**
 * What the assistant said, as this page shows it: a line written for email or text ("Reply HUMAN at any time…") reads
 * as this page's own way to a person (`open`: the "I'd rather talk to a person" button is on the page), or by email once
 * the conversation has closed (polish list). The transcript itself is not changed.
 */
function assistantWords(content: string, open: boolean): string {
  return forTheWeb(content, open ? PERSON_ON_THE_WEB : PERSON_BY_EMAIL);
}

/**
 * One message: the assistant's on the left, the candidate's own on the right (their answers in their own words, taps
 * and changes included), a skipped question as a quiet note.
 */
function Bubble(props: { line: Line; open: boolean }) {
  const { line } = props;
  if (line.role === "system") return <li class="msg system">{line.content === SKIPPED_MESSAGE ? "You skipped this question." : line.content === MOVED_ON_MESSAGE ? "You moved on. Your answer is kept." : assistantWords(line.content, props.open)}</li>;
  if (line.role === "candidate") return <li class="msg candidate"><span class="sr-only">You said: </span>{line.content}</li>;
  return <li class="msg assistant"><span class="sr-only">The assistant said: </span>{assistantWords(line.content, props.open)}</li>;
}

/** On top of every conversation page (plan E2): who the candidate is talking to, before anything else. */
function AiLine(props: { companyName: string }) {
  return <p class="ai-line"><span class="ai-tag">AI assistant</span><span>This conversation is with {props.companyName}'s AI assistant, a software program, not a person. People on the hiring team make every decision.</span></p>;
}

/** Every page of the conversation: the AI line, the company and the job, the page, the AI notice, the privacy link. */
function ConversationPage(props: { view: ConversationView; title: string; children?: unknown }) {
  const { view } = props;
  return (
    <Layout title={`${props.title}: ${view.roleTitle} at ${view.companyName}`} extraCss={SCREEN_CSS}>
      <AiLine companyName={view.companyName} />
      <p class="eyebrow">{view.companyName} · {view.roleTitle}</p>
      {props.children}
      {view.intro.aiNotice ? <p class="notice">{view.intro.aiNotice.text}</p> : null}
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** "Question 2 of 5" over a thin bar. */
function Progress(props: { at: number; total: number; text: string }) {
  return (
    <div class="progress">
      <label for="progress">{props.text}</label>
      <progress id="progress" max={Math.max(1, props.total)} value={Math.min(props.at, Math.max(1, props.total))}>{props.text}</progress>
    </div>
  );
}

/**
 * "Skip this question" (E11): a second submit button that needs nothing typed, no check by the browser and no script.
 * While the assistant follows up on an answer already given, the same button moves on and keeps that answer, and says so.
 */
function SkipButton(props: { keepsAnswer?: boolean }) {
  return <button class="link-action" type="submit" name="action" value="skip" formnovalidate>{props.keepsAnswer ? "Keep my answer and move on" : "Skip this question"}</button>;
}

/** The typed answer. Its label names the question (or the follow-up) it answers, for a screen reader (E14). */
function TypedAnswer(props: { action: string; about: string; submit: string; skip: boolean; keepsAnswer?: boolean; autofocus?: boolean; value?: string }) {
  return (
    <form method="post" action={props.action}>
      <label for="message">Your answer<span class="sr-only"> to: {props.about}</span></label>
      <textarea id="message" name="message" rows={4} maxlength={2000} required autofocus={props.autofocus} aria-describedby="message-hint">{props.value ?? ""}</textarea>
      <small id="message-hint">In your own words. A few sentences is plenty, and there are no wrong answers.</small>
      <div class="actions">
        <button class="btn" type="submit">{props.submit}</button>
        {props.skip ? <SkipButton keepsAnswer={props.keepsAnswer} /> : null}
      </div>
    </form>
  );
}

/**
 * Tap answers (E12) for the factual questions: yes or no, the days of the week, a start date, a pay range. Recorded word
 * for word without the model; typing stays possible below.
 */
function TapAnswerForm(props: { action: string; tap: TapFormat; about: string; submit: string; skip: boolean }) {
  const { tap } = props;
  const skip = props.skip ? <SkipButton /> : null;
  if (tap.kind === "yes_no") {
    return (
      <form method="post" action={props.action}>
        <input type="hidden" name="tap" value="yes_no" />
        <div class="actions" role="group" aria-label={`Your answer to: ${props.about}`}>
          <button class="btn secondary" type="submit" name="choice" value="yes">Yes</button>
          <button class="btn secondary" type="submit" name="choice" value="no">No</button>
          {skip}
        </div>
      </form>
    );
  }
  return (
    <form method="post" action={props.action}>
      <input type="hidden" name="tap" value={tap.kind} />
      {tap.kind === "days" ? (
        <fieldset>
          <legend>Tick every day you can work</legend>
          <div class="days">{tap.options.map((d) => <label class="check slot"><input type="checkbox" name="days" value={d} /> {d}</label>)}</div>
        </fieldset>
      ) : tap.kind === "start_date" ? (
        <>
          <label for="tap-date">The earliest day you could start</label>
          <input id="tap-date" type="date" name="date" required />
        </>
      ) : (
        <fieldset>
          <legend>The pay you are looking for, {tap.basis === "hourly" ? "an hour" : "a year"}{tap.currency === "USD" ? ", in US dollars" : `, in ${tap.currency}`}</legend>
          <div class="pay-pair">
            <div>
              <label for="tap-min">From</label>
              <input id="tap-min" type="number" name="min" min="1" step="any" inputmode="decimal" required />
            </div>
            <div>
              <label for="tap-max">To (optional)</label>
              <input id="tap-max" type="number" name="max" min="1" step="any" inputmode="decimal" />
            </div>
          </div>
        </fieldset>
      )}
      <div class="actions">
        <button class="btn" type="submit">{props.submit}</button>
        {skip}
      </div>
    </form>
  );
}

/** A tap answer where the question takes one, with the candidate's own words one click away; otherwise the words. */
function AnswerForms(props: { action: string; tap: TapFormat | null; about: string; submit: string; skip: boolean; keepsAnswer?: boolean; value?: string }) {
  if (!props.tap) return <TypedAnswer action={props.action} about={props.about} submit={props.submit} skip={props.skip} keepsAnswer={props.keepsAnswer} autofocus value={props.value} />;
  return (
    <>
      <TapAnswerForm action={props.action} tap={props.tap} about={props.about} submit={props.submit} skip={props.skip} />
      <details class="own-words">
        <summary>Answer in your own words instead</summary>
        <TypedAnswer action={props.action} about={props.about} submit={props.submit} skip={false} value={props.value} />
      </details>
    </>
  );
}

/** Always there, and quiet: a person instead (E3), and the link by email to finish later (E2, E4). */
function AsideActions(props: { base: string; later: boolean }) {
  return (
    <div class="aside-actions">
      <a class="link-action" href={`${props.base}/person`}>I'd rather talk to a person</a>
      {props.later ? <form method="post" action={`${props.base}/later`}><button class="link-action" type="submit">Finish later: email me the link</button></form> : null}
    </div>
  );
}

/** What went wrong with the last thing sent, in the candidate's words (the codes come from `turnErrorCode`). */
const TURN_ERRORS: Record<string, string> = {
  empty: "Please type an answer first, or press Skip this question.",
  tap: "That answer does not fit this question. Please check it, or answer in your own words instead.",
  stale: "This page was out of date, so nothing was saved. Here is where the conversation is now.",
  trouble: "Something went wrong on our end. Please send that again in a minute.",
};

function turnErrorCode(message: string): string {
  if (/type an answer/i.test(message)) return "empty";
  if (/does not fit/i.test(message)) return "tap";
  if (/no question to answer/i.test(message)) return "stale";
  return "trouble";
}

function ErrorNote(props: { code?: string | null }) {
  const text = props.code ? TURN_ERRORS[props.code] : undefined;
  return text ? <div class="err" role="alert">{text}</div> : null;
}

/**
 * The fixed introduction (E2), before the first question: it is the company's AI assistant, not a person; what it is for;
 * a conversation, not a test; how many questions and minutes; skip, stop and come back; then Start, Do this later, or
 * I'd rather talk to a person. Nothing here is written by the model. Start shows the first question at once.
 */
function IntroPage(props: { view: ConversationView; applied: string | null }) {
  const { view } = props;
  const { intro } = view;
  const base = screenPath(view.token);
  // The packet's lines are written for email ("Reply HUMAN…", "This message was sent by…"): on this page a person is one
  // press away, so it says that, and keeps whatever else the company wrote (polish list).
  const teamLine = forTheWeb(intro.humanAlternative);
  const disclosure = forTheWeb(intro.packetDisclosure);
  return (
    <ConversationPage view={view} title="Before you start">
      {props.applied ? (
        <div class="card" role="status">
          <strong>Your application is sent.</strong>
          <p>Your own link to it is on its way to {props.applied}. If you applied for this job before, it may be in one of our earlier emails.</p>
        </div>
      ) : null}
      <h1>{intro.title}</h1>
      <p class="lead">{intro.disclosure}</p>
      <ul class="points">
        <li><Icon name="people" /><span>It is a conversation, not a test. There are no trick questions: answer in your own words, as briefly as you like.</span></li>
        <li><Icon name="clock" /><span>About {intro.questions} {intro.questions === 1 ? "question" : "questions"} and {intro.minutes} minutes, one question at a time.</span></li>
        <li><Icon name="check" /><span>You can skip any question, or stop and come back later: this page keeps your place.</span></li>
        <li><Icon name="eye" /><span>It helps the hiring team at {view.companyName} learn about your work beyond your resume. Your answers go to them, and people decide.</span></li>
      </ul>
      {teamLine ? <p class="pre">{teamLine}</p> : null}
      <p>Would you rather talk to a person? {PERSON_ON_THE_WEB}</p>
      <div class="actions">
        <form method="post" action={`${base}/start`}><button class="btn" type="submit">Start</button></form>
        <form method="post" action={`${base}/later`}><button class="btn secondary" type="submit">Do this later</button></form>
        <a class="btn secondary" href={`${base}/person`}>I'd rather talk to a person</a>
      </div>
      <p class="meta">"Do this later" emails you the link. "I'd rather talk to a person" lets you send your application without the conversation, or have a person contact you.</p>
      {disclosure ? <p class="notice">{disclosure}</p> : null}
    </ConversationPage>
  );
}

/**
 * One question at a time: "Question 2 of 5" and a thin bar, the earlier questions folded away with the candidate's own
 * answers beside the assistant's lines (polish list), the question in large type, the candidate's answers as their own
 * messages and the assistant's follow-ups quoting them, then the answer: taps for the factual questions (E12), words
 * otherwise, with a quiet "Skip this question" (E11). A person, or finishing later, is always one click away.
 */
function QuestionPage(props: { view: ConversationView; error?: string | null }) {
  const { view } = props;
  const base = screenPath(view.token);
  const q = view.current;
  const n = questionNumber(view);
  const { earlier, leadIn, exchange } = aroundQuestion(view);
  const last = exchange.at(-1);
  // The assistant asked a follow-up about this question: the answer is to that, in words.
  const followUp = q && last?.role === "assistant" && !view.withdrawPending ? assistantWords(last.content, true) : null;
  const heading = q?.question ?? "Your conversation";
  const said = leadIn ? assistantWords(leadIn, true) : null;
  return (
    <ConversationPage view={view} title={q ? `Question ${n} of ${view.total}` : "Your conversation"}>
      <Progress at={q ? n : view.answered} total={view.total} text={q ? `Question ${n} of ${view.total}` : `${view.answered} of ${view.total} answered`} />
      {earlier.length ? (
        <details class="earlier">
          <summary>Earlier in the conversation</summary>
          <ol class="thread" aria-label="Earlier questions and your answers">{earlier.map((l) => <Bubble line={l} open />)}</ol>
        </details>
      ) : null}
      {said ? <p class="lead-in"><span class="sr-only">The assistant said: </span>{said}</p> : null}
      <h1 class="question" id="question">{heading}</h1>
      {exchange.length ? <ol class="thread" aria-label="This question so far">{exchange.map((l) => <Bubble line={l} open />)}</ol> : null}
      {view.withdrawPending ? (
        // WITHDRAW asked first (Wave 0 item 0.7): nothing is withdrawn until the candidate presses the first button.
        <div class="card" role="status">
          <strong>Do you want to withdraw your application?</strong>
          <p>Withdrawing ends this conversation and your application for {view.roleTitle}. To keep going instead, just type your answer below.</p>
          <form method="post" action={`${base}/withdraw`} class="actions">
            <button class="btn" type="submit" name="confirm" value="yes">Yes, withdraw my application</button>
            <button class="btn secondary" type="submit" name="confirm" value="no">No, keep my application</button>
          </form>
        </div>
      ) : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={base} tap={followUp ? null : q?.tap ?? null} about={followUp ?? heading} submit="Send" skip={!!q} keepsAnswer={!!q?.answered} />
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/** One answer on the "check your answers" page, marked when it was changed or skipped, with its link to change it. */
function AnswerItem(props: { item: ReviewItem; n: number; base: string }) {
  const { item } = props;
  const mark = item.status === "edited" ? "Changed" : item.status === "declined" ? "Skipped" : item.status === "unanswered" ? "Not answered" : null;
  return (
    <li class="answer" id={`a-${item.key}`}>
      <div class="answer-head">
        <p class="answer-q">{props.n}. {item.question}</p>
        {mark ? <span class="pill">{mark}</span> : null}
      </div>
      <p class="pre">{item.answer ?? (item.status === "declined" ? "You skipped this question." : "No answer yet.")}</p>
      <a href={`${props.base}/answers/${encodeURIComponent(item.key)}`}>{item.answer ? "Change" : "Answer it"}<span class="sr-only"> (question {props.n})</span></a>
    </li>
  );
}

/**
 * "Check your answers" (E10): every answer with its Change link, changed and skipped ones marked, then Send. It never
 * promises the answers are private until Send: the team's panel shows them as they are given, changes included, and
 * someone who does not press Send has them sent as they are (the screen workflow's idle_remind and close_unfinished:
 * one reminder unless they already had one, then two days). Keep it in step with sendConversationReviewReminder and
 * counsel register item 20.
 */
function ReviewPage(props: { view: ConversationView; changed: string | null; error?: string | null }) {
  const { view } = props;
  const base = screenPath(view.token);
  const items = view.review ?? [];
  return (
    <ConversationPage view={view} title="Check your answers">
      <Progress at={view.total} total={view.total} text={`All ${view.total} questions done`} />
      <h1>Check your answers</h1>
      <p class="lead">This is what you told the assistant. The hiring team can see your answers as you give them, including any you change. Change any answer you like, then press Send to tell them you are finished.</p>
      <p>If you do not press Send, we send your answers as they are a few days after your last answer or change. If we have not reminded you yet, we email you once before then.</p>
      {props.changed && items.some((i) => i.key === props.changed) ? <div class="card" role="status"><strong>Your answer is changed.</strong></div> : null}
      <ErrorNote code={props.error} />
      <ol class="answers">{items.map((item, i) => <AnswerItem item={item} n={i + 1} base={base} />)}</ol>
      <form method="post" action={`${base}/submit`}>
        <button class="btn" type="submit">Send my answers</button>
      </form>
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/** Changing one answer (E10), from "check your answers": the question in large type, the answer now, and a new one. */
function EditPage(props: { view: ConversationView; item: ReviewItem; n: number; error?: string | null }) {
  const { view, item } = props;
  const base = screenPath(view.token);
  return (
    <ConversationPage view={view} title="Change your answer">
      <p class="back"><a href={`${base}#a-${item.key}`}><Icon name="arrow-left" />Back to your answers</a></p>
      <p class="meta">Question {props.n} of {view.total}</p>
      <h1 class="question" id="question">{item.question}</h1>
      {item.answer ? <div class="card"><strong>Your answer now</strong><p class="pre">{item.answer}</p></div> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={`${base}/answers/${encodeURIComponent(item.key)}`} tap={item.tap} about={item.question} submit="Save this answer" skip={false} value={item.tap ? undefined : item.answer ?? undefined} />
    </ConversationPage>
  );
}

/** What a closed conversation says, by how it closed (plan E3, E4, E5, A7, A9). Never why a team stopped it. */
function closedWords(view: ConversationView): { title: string; lines: string[] } {
  const co = view.companyName;
  switch (view.status) {
    case "completed":
      return { title: "Thanks, your answers are sent", lines: [`The hiring team at ${co} reads them with your application. People on the team make every decision, and you will hear from them either way.`, "If anything else is needed from you, we will email you."] };
    case "human_requested": {
      // The time promised when they asked, never a new one each visit. Past it, the page cannot tell whether someone
      // already called (the status stays the same), so it says how to chase it rather than that nobody did.
      const asked = view.personAsked;
      const when = !asked
        ? `Someone working with the hiring team at ${co} will contact you. If nobody has been in touch, reply to any of our emails.`
        : asked.overdue
          ? `Someone working with the hiring team at ${co} was due to contact you by ${asked.dueWords}. If nobody has been in touch yet, reply to any of our emails and we will follow it up.`
          : `Someone working with the hiring team at ${co} aims to contact you by ${asked.dueWords}.`;
      return { title: "A person will be in touch", lines: [when, "Anything you answered is kept. Nothing else is needed from you here."] };
    }
    case "declined_by_candidate":
      return { title: "Your application is with the hiring team", lines: [`It went to the hiring team at ${co} without the conversation. People on the team review it, and you will hear from them either way.`] };
    case "paused":
      return { title: "The conversation is paused", lines: [`Sorry, ${co}'s AI assistant has stopped working for the moment. Your answers so far are saved.`, "We will email you a link to finish as soon as it is working again, usually within a few hours."] };
    case "unfinished":
      return { title: "This conversation has closed", lines: [`It closed before every question was answered. What you said has gone to the hiring team at ${co} with your application, which carries on. Nothing else is needed from you.`] };
    case "expired":
      // The conversation that goes with the application, never started: the application went on without it (E4).
      if (view.oneVisit) return { title: "This conversation has closed", lines: [`Your application has gone to the hiring team at ${co} without it, and that is fine. Nothing else is needed from you; you will hear from them either way.`, "If you would like to add something, reply to any of our emails."] };
      return { title: "This link has expired", lines: ["This screening link has expired. Reply to any of our emails and a person will pick it up with you."] };
    case "abandoned":
      return { title: "Your application is withdrawn", lines: ["This application was withdrawn. Thank you for your time."] };
    default:
      // Stopped by the team before it started (plan A7), or closed with the application (A9): nothing about why.
      return { title: "This screening conversation is closed", lines: ["Nothing more is needed from you here. If you have a question, reply to any of our emails."] };
  }
}

function ClosedPage(props: { view: ConversationView }) {
  const { view } = props;
  const words = closedWords(view);
  return (
    <ConversationPage view={view} title={words.title}>
      <h1>{words.title}</h1>
      <div class="card" role="status">{words.lines.map((l) => <p>{l}</p>)}</div>
      {/* While the assistant is down a person is still one click away (E5). */}
      {view.status === "paused" ? <p>Would you rather not wait? <a href={`${screenPath(view.token)}/person`}>Talk to a person instead</a>.</p> : null}
      {view.transcript.length ? (
        <details class="earlier">
          <summary>See the conversation</summary>
          <ol class="thread" aria-label="The questions and your answers">{view.transcript.map((l) => <Bubble line={l} open={false} />)}</ol>
        </details>
      ) : null}
    </ConversationPage>
  );
}

/** "I'd rather talk to a person" (E3, Q16): two equal choices, and both are fine. */
function PersonPage(props: { view: ConversationView }) {
  const { view } = props;
  const base = screenPath(view.token);
  return (
    <ConversationPage view={view} title="Talk to a person instead">
      <p class="back"><a href={base}><Icon name="arrow-left" />Back to the conversation</a></p>
      <h1>Talk to a person instead</h1>
      <p class="lead">That is fine. Choose whichever suits you. Anything you have answered so far is kept.</p>
      <div class="paths">
        <section class="card" aria-labelledby="path-send">
          <h2 id="path-send">Send my application as it is</h2>
          <p>Your application goes to the hiring team at {view.companyName} without the conversation. People on the team review it, and you will hear from them either way.</p>
          <form method="post" action={`${base}/person`}>
            <input type="hidden" name="choice" value="send_without" />
            <button class="btn secondary" type="submit">Send without the conversation</button>
          </form>
        </section>
        <section class="card" aria-labelledby="path-person">
          <h2 id="path-person">Have a person contact me</h2>
          <p>A recruiter working with the hiring team at {view.companyName} will get in touch {view.personExpectation}, to go through the questions with you or answer yours.</p>
          <form method="post" action={`${base}/person`}>
            <input type="hidden" name="choice" value="contact_me" />
            <button class="btn secondary" type="submit">Have a person contact me</button>
          </form>
        </section>
      </div>
    </ConversationPage>
  );
}

/** After "Do this later" (E2): the link went by email, to the address on the application; the place is kept. */
function LaterPage(props: { view: ConversationView }) {
  const { view } = props;
  return (
    <ConversationPage view={view} title="Your link is on its way">
      <h1>Your link is on its way</h1>
      <div class="card" role="status">
        <strong>We emailed you the link to this conversation.</strong>
        <p>It went to the email address on your application. It keeps your place, so open it whenever suits you in the next few days.</p>
      </div>
      <p>Changed your mind? <a href={screenPath(view.token)}>Start now instead</a>.</p>
    </ConversationPage>
  );
}

type FormBody = Record<string, string | File | (string | File)[]>;
const field = (body: FormBody, key: string): string => {
  const v = body[key];
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
};
const fields = (body: FormBody, key: string): string[] => (Array.isArray(body[key]) ? (body[key] as unknown[]) : [body[key]]).filter((x): x is string => typeof x === "string");

/** A tapped answer from the form (E12), checked against the contract; null when it does not parse (an empty pay box, no day ticked). */
function tapFrom(body: FormBody, kind: string): TapAnswer | null {
  const amount = (s: string) => (s.trim() ? Number(s.replace(/[$,\s]/g, "")) : undefined);
  const raw = kind === "yes_no" ? { kind, choice: field(body, "choice") } : kind === "days" ? { kind, days: fields(body, "days") } : kind === "start_date" ? { kind, date: field(body, "date") } : kind === "pay_range" ? { kind, min: amount(field(body, "min")), max: amount(field(body, "max")) } : null;
  const parsed = TapAnswer.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What the candidate did: pressed "Skip this question" (E11), tapped an answer (E12), or typed. Null for a tap that does not parse. */
function turnActionFrom(body: FormBody): TurnAction | null {
  if (field(body, "action") === "skip") return { skip: true };
  const kind = field(body, "tap");
  if (kind) {
    const tap = tapFrom(body, kind);
    return tap ? { tap } : null;
  }
  return { message: field(body, "message") };
}

/** A question's key in an address: the packet's own keys are short snake_case. */
const ANSWER_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The conversation page, the same for a first application and a repeat one (Q14 x Q15): it reads only the view the
 * service gives, so the two cannot render differently. Every conversation on the web, offered with the application or
 * invited by email later, opens on the fixed introduction (plan E2); nothing on it is written by the model.
 */
candidatePages.get("/c/screen/:token", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  // Opening the link writes nothing (a mail scanner may open it): the introduction is fixed, and Start shows the first question.
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  c.header("Cache-Control", "no-store");
  const error = c.req.query("error") ?? null;
  if (view.phase === "intro") return c.html(<IntroPage view={view} applied={appliedTo(c, view.token)} />);
  if (view.phase === "review") return c.html(<ReviewPage view={view} changed={c.req.query("changed") ?? null} error={error} />);
  if (view.phase === "closed") return c.html(<ClosedPage view={view} />);
  return c.html(<QuestionPage view={view} error={error} />);
});

/** An answer: typed, tapped (E12) or skipped (E11). Commands (HUMAN, WITHDRAW), skips and taps never reach the model. */
candidatePages.post("/c/screen/:token", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const base = screenPath(found.ref.token);
  const action = turnActionFrom(await c.req.parseBody({ all: true }));
  if (!action) return c.redirect(`${base}?error=tap`);
  if (!action.skip && !action.tap && !(action.message ?? "").trim()) return c.redirect(`${base}?error=empty`);
  const result = await conversationTurn(container, found.ref, action);
  return c.redirect(result.kind === "error" ? `${base}?error=${turnErrorCode(result.message)}` : base);
});

/** "Start" on the introduction (E2): the first question, in the packet's words, at once. Pressing twice changes nothing. */
candidatePages.post("/c/screen/:token/start", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await conversationStart(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});

/** "Do this later" (E2) and "Finish later": the link goes by email to the address on the application, never to the page. */
candidatePages.post("/c/screen/:token/later", rateLimit(POLICIES.screenLater), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const base = screenPath(found.ref.token);
  return c.redirect((await conversationLater(container, found.ref)) ? `${base}/later?sent=1` : base);
});

candidatePages.get("/c/screen/:token/later", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  if (c.req.query("sent") !== "1" || view.phase === "closed") return c.redirect(screenPath(view.token));
  c.header("Cache-Control", "no-store");
  return c.html(<LaterPage view={view} />);
});

/** "I'd rather talk to a person" (E3): the choice page. Open while the conversation can still be answered, or is paused (E5). */
candidatePages.get("/c/screen/:token/person", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  if (!SCREEN_PERSON_ROUTE_STATUSES.includes(view.status)) return c.redirect(screenPath(view.token));
  c.header("Cache-Control", "no-store");
  return c.html(<PersonPage view={view} />);
});

/**
 * The choice (Q16): `send_without` sends the application on without the conversation; `contact_me` asks a recruiter to
 * get in touch within four business hours. Both are counted. The page then says what happens next.
 */
candidatePages.post("/c/screen/:token/person", rateLimit(POLICIES.screenHuman), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.choice === "send_without" || body.choice === "contact_me") await conversationPerson(container, found.ref, body.choice);
  return c.redirect(screenPath(found.ref.token));
});

/** The earlier one-button route: it now leads to the choice (E3), and changes nothing by itself. */
candidatePages.post("/c/screen/:token/human", rateLimit(POLICIES.screenHuman), async (c) => {
  const found = await openConversation(c.get("container"), c.req.param("token") ?? "");
  if (!found) return c.notFound();
  return c.redirect(`${screenPath(found.ref.token)}/person`);
});

/**
 * The answer to "do you want to withdraw?" on the web (Wave 0 item 0.7): `confirm=yes` withdraws the application and
 * closes the conversation, `confirm=no` keeps it and picks up where it was. The link itself is the proof, as on the
 * status page; a conversation that already ended is left as it is. A repeat submission's copy withdraws nothing: its
 * email sends the address owner to their own status page (services/apply-conversation.ts).
 */
candidatePages.post("/c/screen/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const body = await c.req.parseBody();
  // Withdrawing here leaves the process like the status page's button does (plan A9): the service cleans up.
  if (body.confirm === "yes" || body.confirm === "no") await conversationWithdraw(container, found.ref, body.confirm === "yes");
  return c.redirect(screenPath(found.ref.token));
});

/** The plan's address for "check your answers" (E10): the conversation's own page shows it once every question is done. */
candidatePages.get("/c/screen/:token/review", async (c) => {
  const found = await openConversation(c.get("container"), c.req.param("token"));
  if (!found) return c.notFound();
  return c.redirect(screenPath(found.ref.token));
});

/** Changing one answer (E10). Only while the candidate is checking their answers; otherwise back to the conversation. */
candidatePages.get("/c/screen/:token/answers/:key", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  if (view.phase !== "review" || !view.review) return c.redirect(screenPath(view.token));
  const at = view.review.findIndex((i) => i.key === c.req.param("key"));
  if (at < 0) return c.notFound();
  c.header("Cache-Control", "no-store");
  return c.html(<EditPage view={view} item={view.review[at]} n={at + 1} error={c.req.query("error") ?? null} />);
});

/** The new answer, typed or tapped, added to the transcript beside the earlier one (the quote check covers both). */
candidatePages.post("/c/screen/:token/answers/:key", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const key = c.req.param("key") ?? "";
  if (!ANSWER_KEY.test(key)) return c.notFound();
  const base = screenPath(found.ref.token);
  const here = `${base}/answers/${encodeURIComponent(key)}`;
  const action = turnActionFrom(await c.req.parseBody({ all: true }));
  if (!action) return c.redirect(`${here}?error=tap`);
  if (action.skip) return c.redirect(base);
  const out = await conversationEdit(container, found.ref, { questionKey: key, text: action.message ?? null, tap: action.tap ?? null });
  if (out.ok) return c.redirect(`${base}?changed=${encodeURIComponent(key)}#a-${key}`);
  const code = turnErrorCode(out.error);
  return c.redirect(code === "empty" || code === "tap" ? `${here}?error=${code}` : base);
});

/** "Send my answers" (E10): the conversation is complete. A second press changes nothing. */
candidatePages.post("/c/screen/:token/submit", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await conversationSubmit(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});

/* ------------------------------------------------------------------------------------------------------------ */
/* A repeat submission's answers, confirmed by the owner of the address on file (Q14 x Q15)                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the emailed link opens: one button while it can still be used, otherwise what happened. Counts only, never the answers. */
function ConfirmAnswersPage(props: { view: RepeatConfirmationView; token: string }) {
  const { view } = props;
  // A person asked for, or offered because the assistant stopped working part-way (nobody asked): confirming brings one in.
  const person = view.intent === "person" || view.intent === "outage";
  const happened = view.intent === "outage" ? "started the screening questions, but our assistant stopped working before they finished" : person ? "asked for a person from the hiring team to contact them" : `answered ${view.answered} of the ${view.questions} screening questions`;
  const outcome: Record<Exclude<RepeatConfirmationView["state"], "ready">, { title: string; text: string }> = {
    added: { title: "Your answers are added", text: `They are now part of your application for ${view.roleTitle} at ${view.companyName}, and the hiring team reads them with it. Nothing else is needed from you.` },
    person: { title: "A person will be in touch", text: `We have asked the hiring team at ${view.companyName} to contact you about your application for ${view.roleTitle}. Nothing else is needed from you.` },
    not_added: { title: "Nothing was added", text: "Your application already has answers to these questions, or it has moved on, so it stays as it was. Nothing else is needed from you." },
    gone: { title: "This link has expired", text: "It was already used, or more than seven days went by and what was typed was deleted. Nothing was added to your application." },
  };
  const done = view.state === "ready" ? null : outcome[view.state];
  return (
    <Layout title={done ? done.title : "Please confirm"}>
      <p class="eyebrow">{view.companyName} · {view.roleTitle}</p>
      {done ? (
        <>
          <h1>{done.title}</h1>
          <div class="card" role="status"><p>{done.text}</p></div>
        </>
      ) : (
        <>
          <h1>{person ? "Ask a person to contact you?" : "Add these answers to your application?"}</h1>
          <p class="lead">Someone using your email address applied again for this job and {happened}. Nothing has been added to your application yet.</p>
          <form method="post" action={`/c/confirm-answers/${props.token}`} class="card">
            <p>If that was you, press the button {person ? "and a person will be in touch" : "to add those answers to your application"}.</p>
            <button class="btn" type="submit">{person ? "Yes, ask a person to contact me" : "Add these answers to my application"}</button>
          </form>
          <p>If it was not you, you do not need to do anything: nothing is added, and what was typed is deleted after seven days.</p>
        </>
      )}
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** Opening the link changes nothing (a mail scanner may open it); only the button does. */
candidatePages.get("/c/confirm-answers/:token", async (c) => {
  const container = c.get("container");
  const token = c.req.param("token");
  const view = await repeatConfirmationView(container.db, token, container.engine.clock());
  if (!view) return c.notFound();
  c.header("Cache-Control", "no-store");
  return c.html(<ConfirmAnswersPage view={view} token={token} />);
});

candidatePages.post("/c/confirm-answers/:token", rateLimit(POLICIES.confirmAnswers), async (c) => {
  const token = c.req.param("token") ?? "";
  const view = await confirmRepeat(c.get("container"), token);
  if (!view) return c.notFound();
  return c.redirect(`/c/confirm-answers/${token}`);
});

/** After a fulfilled deletion the link is dead: the page says so and nothing is recorded or sent (docs/readiness/14). */
async function anonymizedFor(container: Container, candidateId: string): Promise<boolean> {
  const [cand] = await container.db.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, candidateId)).limit(1);
  return !!cand?.anonymizedAt;
}
function linkGone(c: Context<Vars>) {
  return c.html(<Layout title="This link is no longer active"><h1>This link is no longer active</h1><p>The information behind it was removed at your request. Nothing more can be sent or changed through this page.</p></Layout>, 410);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Candidate self-service (docs/FOUNDER-CONTEXT.md §12): withdraw in one click; text-message preference.        */
/* ------------------------------------------------------------------------------------------------------------ */

/** Privacy requests from the candidate's own status link (correction 7): verified by the link, recorded, acknowledged, tracked to a deadline. */
candidatePages.post("/c/status/:token/privacy", rateLimit(POLICIES.privacy), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const form = await c.req.parseBody();
  const parsed = CandidatePrivacyRequest.safeParse({ kind: form.kind, details: form.details || undefined });
  if (!parsed.success) return c.redirect(`/c/status/${app.statusToken}`);
  const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [company] = await container.db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const actor = { kind: "candidate" as const, id: app.candidateId };
  // Trust boundary (docs/readiness/14): everything below comes from the application the token names. The form supplies only
  // the kind and the candidate's words; any other field is ignored. A repeat of the same request within a day answers the
  // earlier record instead of opening another (replays are idempotent).
  const row = await withPlatform(container.db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${app.id}))`).catch(() => undefined); // two clicks in flight become one request
    const since = new Date(container.engine.clock().getTime() - 24 * 3600_000).toISOString();
    const recent = await tx.select().from(dataRequests).where(and(eq(dataRequests.applicationId, app.id), eq(dataRequests.kind, parsed.data.kind), eq(dataRequests.channel, "status_page"), inArray(dataRequests.status, ["received", "in_progress", "awaiting_counsel"]))).orderBy(desc(dataRequests.createdAt)).limit(5);
    const same = recent.find((x) => (x.details ?? "") === (parsed.data.details ?? "") && Date.parse(x.createdAt) >= Date.parse(since));
    if (same) {
      await audit(tx, { companyId: app.companyId, actor, action: "data_request.replayed", target: { type: "candidate", id: app.candidateId }, reason: parsed.data.kind, details: { requestId: same.id } });
      return same;
    }
    let r = await createDataRequest(tx, { companyId: app.companyId, kind: parsed.data.kind, requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`, details: parsed.data.details, candidateId: app.candidateId, applicationId: app.id, channel: "status_page", verified: true, actor, now: container.engine.clock() });
    if (parsed.data.kind === "human_review") r = await openHumanReview(tx, r, { roleId: app.roleId, actor });
    await sendPrivacyAcknowledgment(tx, container.integrations, { row: r, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return r;
  });
  await container.kick();
  return c.redirect(`/c/status/${app.statusToken}?request=${row.id.slice(0, 8)}`);
});

candidatePages.post("/c/status/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.confirm !== "yes") return c.redirect(`/c/status/${app.statusToken}?confirm=withdraw`);
  // Anyone still in the process may withdraw, and so may someone whose decision they were never told: for them nothing
  // has been decided yet (plan A1). Leaving cleans up: their screens close, and an interview they knew about is called
  // off with a short note confirming it (plan A9).
  if (mayWithdraw(app.stage, app.toldState)) {
    await withTenant(container.db, app.companyId, async (tx) => {
      const actor = { kind: "candidate" as const, id: app.candidateId };
      await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "withdrawn", by: "candidate", actor, reason: "withdrawn from the status page" });
      await emit(tx, { type: "application.withdrawn", companyId: app.companyId, actor, subject: { type: "application", id: app.id }, payload: { via: "status_page", fromStage: app.stage } });
      await exitCleanup(tx, container, { companyId: app.companyId, applicationId: app.id, reason: "the candidate withdrew", actor, candidateEmail: "send_cancellation" });
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
      await notify(tx, { companyId: app.companyId, kind: "candidate.withdrawn", title: `${cand.firstName} ${cand.lastName} withdrew`, body: `They withdrew from ${role.title} using the link on their status page.`, action: { label: "See talent", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    });
    // the withdrawal is also a recorded request, fulfilled at once, so the audit trail and the confirmation are the same as for any other request (platform role: the tenant role cannot write that table)
    await withPlatform(container.db, async (tx) => {
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const actor = { kind: "candidate" as const, id: app.candidateId };
      const req = await createDataRequest(tx, { companyId: app.companyId, kind: "withdrawal", requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`, candidateId: app.candidateId, applicationId: app.id, channel: "status_page", verified: true, actor, now: container.engine.clock() });
      const done = await fulfilWithdrawal(tx, req, actor, container.engine.clock());
      const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
      if (cand?.email) await sendPrivacyCompletion(tx, container.integrations, { row: done, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
    });
    await container.kick();
  }
  return c.redirect(`/c/status/${app.statusToken}?withdrawn=1`);
});

candidatePages.post("/c/status/:token/sms", rateLimit(POLICIES.smsPref), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody();
  const parsed = CandidateSmsPreference.safeParse({ pref: typeof body.pref === "string" ? body.pref : "" });
  if (!parsed.success) return c.redirect(`/c/status/${app.statusToken}`);
  const on = parsed.data.pref === "on";
  if (on && !container.env.SMS_ENABLED) return c.redirect(`/c/status/${app.statusToken}`); // texting is off (decision M2): nothing to opt in to
  const [current] = await container.db.select({ preferences: candidates.preferences, consent: candidates.consent }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const currentlyOn = !!current?.consent.sms?.granted && !current?.preferences.smsOptOut;
  if (currentlyOn === on) return c.redirect(`/c/status/${app.statusToken}`); // already so: a repeat changes and records nothing
  await withTenant(container.db, app.companyId, async (tx) => {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const actor = { kind: "candidate" as const, id: cand.id };
    const now = new Date().toISOString();
    await tx.update(candidates).set({ preferences: { ...cand.preferences, smsOptOut: !on }, consent: { ...cand.consent, sms: { granted: on, at: now, source: "status_page" } } }).where(eq(candidates.id, cand.id));
    await emit(tx, { type: on ? "consent.granted" : "consent.revoked", companyId: app.companyId, actor, subject: { type: "candidate", id: cand.id }, payload: { purpose: "sms", source: "status_page" } });
  });
  if (!on) {
    // an opt-out is a recorded request too: applied at once, confirmed, kept for the audit trail
    await withPlatform(container.db, async (tx) => {
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const actor = { kind: "candidate" as const, id: app.candidateId };
      const req = await createDataRequest(tx, { companyId: app.companyId, kind: "sms_opt_out", requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`, candidateId: app.candidateId, applicationId: app.id, channel: "status_page", verified: true, actor, now: container.engine.clock() });
      await fulfilSmsOptOut(tx, req, actor, container.engine.clock());
    });
  }
  return c.redirect(`/c/status/${app.statusToken}`);
});

/**
 * "Don't keep me for future roles" (Wave 0 item 0.11): one click on the status link, confirmed by email; a repeat
 * changes nothing. `pref=in` ("Keep me for future roles again") takes the choice back, with nothing sent. Either way the
 * page comes back at the choice, saying it was saved.
 */
candidatePages.post("/c/status/:token/talent-pool", rateLimit(POLICIES.talentPoolPref), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const back = body.pref === "in";
  if (back) await withTenant(container.db, app.companyId, (tx) => optBackIntoTalentPool(tx, { application: app }));
  else if (await withTenant(container.db, app.companyId, (tx) => optOutOfTalentPool(tx, container, { application: app, source: "status_page" }))) await container.kick();
  return c.redirect(`/c/status/${app.statusToken}?pool=${back ? "in" : "out"}#future-roles`);
});
