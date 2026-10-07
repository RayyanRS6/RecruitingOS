/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ApplyRequest, CandidateSmsPreference, MAX_RESUME_BYTES, inspectResumeFile, type RolePacket } from "@ros/contracts";
import { answerWithdrawPrompt, answersOf, focusedPacket, openScreen, requestHuman, runScreenTurn, withdrawPending } from "@ros/agents";
import { STAGE_LABEL, audit, candidateNotices, createDataRequest, emit, fulfilSmsOptOut, fulfilWithdrawal, humanResponseExpectation, jobNoticesFor, loadBusinessCalendar, noticesFor, notify, openHumanReview, openPayload, sealPayload, transition, type Notice } from "@ros/core";
import { CandidatePrivacyRequest } from "@ros/contracts";
import { sendPrivacyAcknowledgment, sendPrivacyCompletion } from "@ros/agents";
import { applications, candidates, communications, companies, dataRequests, interviews, rolePackets, roles, screens, uuidv7, withPlatform, withTenant } from "@ros/db";
import { jobPostingJsonLd, refFor } from "@ros/integrations";
import { randomToken } from "@ros/db";
import { UPLOAD_GRANT_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, checkUploadIntent, quarantineKey } from "../uploads";
import { clientIp, type Vars } from "../middleware/session";
import type { Container } from "../container";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { createApplication, markUploadUsed, queueLinkRequest, uploadAlreadyUsed, type ResumeInput } from "../services/applications";
import { jobUrls } from "../services/job-urls";
import { screenDeps } from "../services/screens";
import { optBackIntoTalentPool, optOutOfTalentPool } from "../services/talent-pool";
import { Icon } from "./icons";
import { JobFacts, payShown, publicPay, roleValidThrough } from "./job-facts";
import { Layout, currentNonce } from "./layout";
import { clearApplicationSource, resolveApplicationSource } from "./links";

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
type ReceiptPayload = { v: 1; roleId: string; to: string; exp: number };

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
function toReceipt(c: Context<Vars>, job: { company: { slug: string }; role: { id: string } }, typedEmail: string) {
  const container = c.get("container");
  const path = receiptPath(job.company.slug, job.role.id);
  const payload: ReceiptPayload = { v: 1, roleId: job.role.id, to: maskEmail(typedEmail), exp: container.engine.clock().getTime() + RECEIPT_TTL_MS };
  setCookie(c, RECEIPT_COOKIE, sealPayload(RECEIPT_PURPOSE, payload, container.env.SESSION_SECRET), { httpOnly: true, sameSite: "Lax", secure: container.env.NODE_ENV === "production", path, maxAge: RECEIPT_TTL_MS / 1000 });
  return c.redirect(path);
}

/**
 * The "accepting applications" switch and a pause (docs/spec/20 item 16) both keep the job page up and close the form:
 * the page says so, the apply routes answer 404, and nobody already in the process is touched.
 */
function acceptingApplications(role: { status: string; acceptingApplications: boolean }): boolean {
  return role.status === "open" && role.acceptingApplications;
}

/** What the job page says instead of the Apply button. */
function closedMessage(role: { status: string }): string {
  return role.status === "closed" ? "This position is closed and no longer taking applications." : "This position is not taking new applications right now.";
}

/**
 * The notice versions recorded as shown (docs/readiness/20 section D): the notices the page renders as text, plus the
 * SMS consent text only when the checkbox was on the page. Computed by the server on every render and again on the
 * submission, never taken from the browser.
 */
function noticeVersionsFor(notices: Notice[], smsEnabled: boolean): string[] {
  const shown = candidateNotices(notices);
  const sms = smsEnabled ? notices.find((n) => n.key === "sms_consent") : undefined;
  return [...shown, ...(sms ? [sms] : [])].map((n) => `${n.key}@${n.version}`);
}

/** Without JavaScript the résumé travels inside the form itself, which the platform refuses above a few megabytes; this cap gives that case a plain answer (D14). */
export const NO_SCRIPT_MAX_RESUME_BYTES = 4 * 1024 * 1024;

async function loadJob(db: Vars["Variables"]["container"]["db"], slug: string, roleId: string) {
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
  if (!company) return null;
  const [role] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.companyId, company.id))).limit(1);
  if (!role?.currentPacketVersion) return null;
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, role.currentPacketVersion))).limit(1);
  if (!pv) return null;
  return { company, role, packet: pv.packet };
}

candidatePages.get("/careers/:slug", async (c) => {
  const db = c.get("container").db;
  const [company] = await db.select().from(companies).where(eq(companies.slug, c.req.param("slug"))).limit(1);
  if (!company) return c.notFound();
  const open = await db.select().from(roles).where(and(eq(roles.companyId, company.id), eq(roles.status, "open"))).orderBy(desc(roles.openedAt));
  return c.html(
    <Layout title={`Careers at ${company.name}`}>
      <p class="eyebrow">Careers</p>
      <h1>Work with {company.name}</h1>
      <p class="lead">{company.settings.careersPage?.intro ?? "We respond to every applicant and keep the process short."}</p>
      {open.length === 0 ? <div class="card">No open positions right now. Check back soon.</div> : null}
      {open.length ? (
        <ul class="roles">
          {open.map((r) => (
            <li class="card role">
              <div>
                <h2>{r.title}</h2>
                {r.acceptingApplications ? null : <p class="meta">Not taking new applications right now.</p>}
              </div>
              <a class="btn secondary" href={`/careers/${company.slug}/jobs/${r.id}`}>{r.acceptingApplications ? "View and apply" : "View details"}<span class="sr-only">: {r.title}</span><Icon name="arrow-right" /></a>
            </li>
          ))}
        </ul>
      ) : null}
      <p class="foot"><a href="/c/link-request">Already applied? Get your application link again</a> · <a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});

candidatePages.get("/careers/:slug/jobs/:roleId", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const { company, role, packet } = job;
  const accepting = acceptingApplications(role);
  const smsEnabled = container.env.SMS_ENABLED;
  const urls = jobUrls(container.env, { slug: company.slug, roleId: role.id });
  const allNotices = jobNotices(packet, company);
  const notices = candidateNotices(allNotices);
  // The JobPosting block stays on paused and closed pages (docs/spec/20 item 4). validThrough is a real date only: the
  // closing day, or the day the role stopped taking applications; an open role with no closing date carries none.
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
    companyLogoUrl: company.settings.logoUrl ?? null,
  });
  return c.html(
    <Layout title={`${packet.identity.title} at ${company.name}`} jsonLd={jsonLd} wide>
      <div class="job-head">
        <p class="eyebrow"><a href={`/careers/${company.slug}`}>Careers at {company.name}</a></p>
        <h1>{packet.identity.title}</h1>
        <JobFacts packet={packet} pay={publicPay(packet, allNotices)} />
      </div>
      {!accepting ? <div class="alert caution" role="status">{closedMessage(role)}</div> : null}
      {/* The description, the steps and the notices come first in reading order; the apply panel follows them (beside them on a wide screen, held at the bottom of a phone's screen). */}
      <div class={accepting ? "job-layout" : "job-layout solo"}>
        <div class="card job-body">
          <h2>About the job</h2>
          <p class="desc">{packet.description.publicJobDescription}</p>
          <h2>What to expect</h2>
          <ol class="steps">
            <li>Apply in about three minutes. We confirm by email.</li>
            <li>A short screening conversation {smsEnabled ? "by text or online" : "online"} (about {packet.screening.maxMinutes} minutes) if your background looks like a fit.</li>
            {packet.interviews.plan.map((r) => <li>{r.title} ({r.durationMinutes} minutes)</li>)}
            <li>A decision, and a real answer either way.</li>
          </ol>
          {notices.filter((n) => n.key === "ai_use" || n.key === "pay_transparency").map((n) => <p class="notice">{n.text}</p>)}
        </div>
        {accepting ? (
          <div class="apply-panel">
            <div class="card apply-card">
              <p class="apply-title">{packet.identity.title}</p>
              <p class="meta">About three minutes. We confirm by email.</p>
              <a class="btn" href={`/careers/${company.slug}/jobs/${role.id}/apply`}>Apply now</a>
            </div>
          </div>
        ) : null}
      </div>
      <p class="foot"><a href="/c/link-request">Already applied? Get your application link again</a> · <a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});

/**
 * What a re-rendered form keeps (D12): every typed value, every eligibility answer, both checkboxes, which fields were
 * missing, and a resume the browser already uploaded directly (its sealed grant goes back into the form, so the file
 * stays attached). A file posted inside the form itself cannot be put back by any browser: `resumeLost` makes the page
 * say so instead of claiming everything is still there.
 */
type ApplyFormState = { values: Record<string, string>; answers: Record<string, string | string[]>; acknowledged: boolean; smsConsent: boolean; missing: string[]; resume: { grant: string; filename: string } | null; resumeLost: boolean };

/** The sentence a re-shown form ends its error with: true about what is still on the page. */
function keptSentence(resumeLost: boolean): string {
  return resumeLost ? "Everything you typed is still here, but please attach your resume again." : "Everything you entered is still here.";
}

type ApplyFormProps = {
  company: { slug: string; name: string };
  role: { id: string };
  packet: RolePacket;
  /** Every notice for the jurisdictions; the form itself decides what is rendered (candidateNotices) and what is a checkbox. */
  notices: Notice[];
  smsEnabled: boolean;
  privacyEmail: string;
  error?: string;
  state?: Partial<ApplyFormState>;
};

/**
 * The transparency block (docs/readiness/20 section D, items 1 to 10) sits above the submit button: who runs the
 * process, what is collected and why, who may see it, how to exercise the candidate's rights, the privacy address, the
 * link to the notice, and the affirmative acknowledgment. Plain words, short sentences, nothing pre-checked.
 */
function TransparencyBlock(props: { company: { name: string }; notices: Notice[]; privacyEmail: string; acknowledged: boolean; missing: boolean; resumeLost: boolean }) {
  return (
    <section class="card" aria-labelledby="before-you-send">
      <h2 id="before-you-send">Before you send</h2>
      <p><strong>{props.company.name}</strong> runs this hiring process and is the employer. People at {props.company.name} make every hiring decision; software only helps organize and summarize.</p>
      <p><strong>What we collect:</strong> your name, your email, your phone number if you give one, where you are based, your resume or the summary you write, and your answers to the questions above.</p>
      <p><strong>Why:</strong> to consider you for this position and to contact you about it. Nothing else.</p>
      <p><strong>Who can see it:</strong> the hiring team at {props.company.name}; an Identified Talent Solutions recruiter only if {props.company.name} brings one in to help; and the companies that run this service for us: hosting, file storage, email delivery, and the AI service that helps organize applications. Each does only its own job; the privacy page linked below says what each one does.</p>
      <p><strong>Your choices:</strong> after you apply, we email you a link to your own status page, where you can ask for a copy of your information, correct it, withdraw your application, or delete your information. You can also email <a href={`mailto:${props.privacyEmail}`}>{props.privacyEmail}</a> at any time. A person handles every request.</p>
      <p><a href="/privacy">Read how we handle your information</a></p>
      {props.notices.map((n) => <p class="notice">{n.text}</p>)}
      <label class="check" for="acknowledged">
        <input id="acknowledged" type="checkbox" name="acknowledged" value="yes" required checked={props.acknowledged} aria-invalid={props.missing ? "true" : undefined} aria-describedby={props.missing ? "acknowledged-error" : undefined} />
        <span>I have read the notice above and I understand that people, not software, make the hiring decisions.</span>
      </label>
      {props.missing ? <p class="err" id="acknowledged-error">Please tick this box to send your application. {keptSentence(props.resumeLost)}</p> : null}
    </section>
  );
}

function ApplyForm(props: ApplyFormProps) {
  const v = props.state?.values ?? {};
  const answers = props.state?.answers ?? {};
  const missing = new Set(props.state?.missing ?? []);
  const shown = candidateNotices(props.notices);
  const smsNotice = props.smsEnabled ? props.notices.find((n) => n.key === "sms_consent") : undefined;
  const eligibility = props.packet.requirements.eligibility;
  const invalid = (field: string) => (missing.has(field) ? "true" : undefined);
  const chosen = (key: string) => (typeof answers[key] === "string" ? (answers[key] as string) : "");
  const chosenDays = (key: string) => (Array.isArray(answers[key]) ? (answers[key] as string[]) : []);
  const kept = props.state?.resume ?? null;
  return (
    <Layout title={`Apply: ${props.packet.identity.title} at ${props.company.name}`}>
      <p class="back"><a href={`/careers/${props.company.slug}/jobs/${props.role.id}`}><Icon name="arrow-left" />Back to the job</a></p>
      {/* The facts of the job stay in view while applying (Wave 0 item 0.8), pay included wherever the page must show it. */}
      <p class="eyebrow">{props.company.name}</p>
      <h1>Apply: {props.packet.identity.title}</h1>
      <JobFacts packet={props.packet} pay={publicPay(props.packet, props.notices)} />
      <p class="lead">It takes about three minutes. Upload a resume, or tell us about your recent work in the box below instead.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" enctype="multipart/form-data" data-upload-intent={`/careers/${props.company.slug}/jobs/${props.role.id}/upload-intent`}>
        <input type="text" name="website" tabindex={-1} autocomplete="off" style="position:absolute;left:-10000px" aria-label="Leave this field empty" />
        <input type="hidden" name="uploadGrant" value={kept?.grant ?? ""} />
        <label for="firstName">First name</label>
        <input id="firstName" type="text" name="firstName" required value={v.firstName ?? ""} aria-invalid={invalid("firstName")} />
        <label for="lastName">Last name</label>
        <input id="lastName" type="text" name="lastName" required value={v.lastName ?? ""} aria-invalid={invalid("lastName")} />
        <label for="email">Email</label>
        <input id="email" type="email" name="email" required value={v.email ?? ""} aria-invalid={invalid("email")} />
        <label for="phone">Mobile phone (optional)</label>
        <input id="phone" type="tel" name="phone" value={v.phone ?? ""} aria-invalid={invalid("phone")} />
        {smsNotice ? <label class="check"><input type="checkbox" name="smsConsent" value="yes" checked={!!props.state?.smsConsent} /> <span>{smsNotice.text}</span></label> : null}
        <label for="locationText">Where are you based? (city, state)</label>
        <input id="locationText" type="text" name="locationText" value={v.locationText ?? ""} aria-invalid={invalid("locationText")} />
        <label for="resume">Resume (PDF, Word, or text; up to 8 MB, or up to 4 MB without JavaScript)</label>
        <input id="resume" type="file" name="resume" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" />
        <small id="upload-note" aria-live="polite">{kept ? `Your resume ${kept.filename} is still attached. Choose a file only if you want to replace it.` : props.state?.resumeLost ? "Your resume is not attached any more. Please choose the file again." : ""}</small>
        <label for="noResume">No resume? Tell us about your most recent work and what you are looking for.</label>
        <textarea id="noResume" name="noResume" rows={4}>{v.noResume ?? ""}</textarea>
        {eligibility.length ? <h2>A few quick questions</h2> : null}
        {eligibility.map((rule) => (
          <div class="card">
            <label for={`elig_${rule.key}`}>{rule.question}</label>
            {rule.type === "schedule_availability" && Array.isArray((rule.expectation as { days?: string[] }).days) && ((rule.expectation as { days?: string[] }).days ?? []).length > 0 ? (
              <div>
                {(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const).map((d) => (
                  <label class="check"><input type="checkbox" name={`elig_${rule.key}`} value={d} checked={chosenDays(rule.key).includes(d)} /> {d}</label>
                ))}
              </div>
            ) : (
              <select id={`elig_${rule.key}`} name={`elig_${rule.key}`} required>
                <option value="" selected={chosen(rule.key) === ""}>Choose…</option>
                <option value="yes" selected={chosen(rule.key) === "yes"}>Yes</option>
                <option value="no" selected={chosen(rule.key) === "no"}>No</option>
              </select>
            )}
            <small>{rule.rationale}</small>
          </div>
        ))}
        <TransparencyBlock company={props.company} notices={shown} privacyEmail={props.privacyEmail} acknowledged={!!props.state?.acknowledged} missing={missing.has("acknowledged")} resumeLost={!!props.state?.resumeLost} />
        <input type="hidden" name="noticeVersionsShown" value={noticeVersionsFor(props.notices, props.smsEnabled).join(",")} />
        <button class="btn" type="submit">Send my application</button>
      </form>
      <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_UPLOAD_JS }} />
    </Layout>
  );
}

/**
 * Direct-to-storage upload (founder decision 2): with script, the résumé goes from the browser straight to storage
 * under a short-lived, single-object authorization and the form carries only a sealed grant; without script, or if
 * the upload fails, the form posts the file itself as before. Plain ES5, no inline handlers (the policy forbids them),
 * no third-party code, nothing about the person leaves the page except the file's name, size and type.
 */
const APPLY_UPLOAD_JS = `(function(){
var form=document.querySelector('form[data-upload-intent]');if(!form||!window.fetch||!window.FormData){return;}
var input=form.querySelector('input[type=file][name=resume]');var grant=form.querySelector('input[name=uploadGrant]');var note=document.getElementById('upload-note');var submit=form.querySelector('button[type=submit]');
if(!input||!grant){return;}
var busy=false;
function say(t){if(note){note.textContent=t;}}
input.addEventListener('change',function(){if(input.files&&input.files.length&&grant.value){grant.value='';say('');}});
function fallback(file){form.removeAttribute('data-upload-intent');if(file.size>4*1024*1024){say('The direct upload did not work. Files over 4 MB can only be sent by the direct upload: please try again in a moment, or choose a smaller file.');busy=false;if(submit){submit.disabled=false;}return;}form.submit();}
form.addEventListener('submit',function(ev){
if(busy){ev.preventDefault();return;}
var file=input.files&&input.files[0];if(!file||grant.value){return;}
ev.preventDefault();busy=true;if(submit){submit.disabled=true;}say('Uploading your resume\u2026');
fetch(form.getAttribute('data-upload-intent'),{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({filename:file.name,size:file.size,type:file.type})})
.then(function(r){return r.json().then(function(j){if(!r.ok){throw new Error((j&&j.error&&j.error.message)||'The upload was refused.');}return j;});})
.then(function(j){return fetch(j.url,{method:j.method,headers:j.headers,body:file}).then(function(r){if(!r.ok){throw new Error('The upload did not complete.');}grant.value=j.grant;});})
.then(function(){input.value='';say('Resume uploaded.');busy=false;if(submit){submit.disabled=false;}form.submit();})
.catch(function(e){say((e&&e.message)||'The upload did not work.');fallback(file);});
});
})();`;

candidatePages.get("/careers/:slug/jobs/:roleId/apply", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job || !acceptingApplications(job.role)) return c.notFound();
  const notices = jobNotices(job.packet, job.company);
  // Funnel measurement without identity (correction 14): a random per-visit reference, no candidate data, no client script; the source comes from the tracked-link cookie when there is one.
  void container.integrations.analytics.capture({ name: "application_started", subjectRef: randomToken(12), companyRef: refFor(job.company.id, container.integrations.analyticsSalt), at: new Date().toISOString(), properties: { source: resolveApplicationSource(c, job.role.id).source } }).catch(() => undefined);
  return c.html(<ApplyForm company={job.company} role={job.role} packet={job.packet} notices={notices} smsEnabled={container.env.SMS_ENABLED} privacyEmail={container.env.PRIVACY_EMAIL} />);
});

/**
 * Step one of a direct upload: the browser describes the file (name, size, type) and receives a short-lived
 * authorization to put exactly one object under a quarantine key, plus the sealed grant the form will carry.
 */
candidatePages.post("/careers/:slug/jobs/:roleId/upload-intent", rateLimit(POLICIES.apply), async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job || !acceptingApplications(job.role)) return c.json({ error: { code: "not_found", message: "This position is not taking new applications right now." } }, 404);
  let raw: unknown = null;
  try { raw = await c.req.json(); } catch { raw = null; }
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
  if (!job || !acceptingApplications(job.role)) return c.notFound();
  const { company, role, packet } = job;
  const smsEnabled = container.env.SMS_ENABLED;
  const notices = jobNotices(packet, company);
  // The versions recorded as shown are the server's own, computed from the same inputs as the render; a browser cannot claim a different set.
  const noticeVersionsShown = noticeVersionsFor(notices, smsEnabled);
  const body = await c.req.parseBody({ all: true });
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : Array.isArray(body[k]) ? String((body[k] as string[])[0]) : "");
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
  const values = { firstName: str("firstName"), lastName: str("lastName"), email: str("email"), phone: str("phone"), locationText: str("locationText"), noResume: str("noResume") };
  const state = (missing: string[] = [], resume: Pick<ApplyFormState, "resume" | "resumeLost"> = { resume: null, resumeLost: false }): Partial<ApplyFormState> => ({ values, answers, acknowledged, smsConsent, missing, ...resume });
  const again = (error: string, missing: string[] = [], resume?: Pick<ApplyFormState, "resume" | "resumeLost">) => c.html(<ApplyForm company={company} role={role} packet={packet} notices={notices} smsEnabled={smsEnabled} privacyEmail={container.env.PRIVACY_EMAIL} error={error} state={state(missing, resume)} />, 400);
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
    noResumeAnswers: values.noResume ? { summary: values.noResume } : undefined,
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
  if (!resume && !parsed.data.noResumeAnswers) return again("Upload a resume or tell us about your recent work in the box provided.", ["noResume"]);

  // The consent record carries the address the trusted proxy reports, never one the client wrote into the header.
  const ip = clientIp(c);
  // The source comes from the tracked-link cookie when it names this role (docs/spec/20 items 8 and 19); the token itself is never stored.
  const origin = resolveApplicationSource(c, role.id);
  // A new application and a repeat one end on the same receipt (Wave 0 item 0.1): the page never shows or links to an
  // existing application, so typing someone else's address reveals nothing and changes nothing on their record.
  await withTenant(container.db, company.id, async (tx) => {
    if (usedUploadId) await markUploadUsed(tx, { companyId: company.id, roleId: role.id, uploadId: usedUploadId });
    return createApplication(tx, container, {
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
    }, { kind: "candidate", id: "applicant" });
  });
  await container.kick();
  clearApplicationSource(c);
  return toReceipt(c, job, parsed.data.email);
});

/** The receipt (Wave 0 item 0.1). Identical for a first application, a repeat one and a bot; it never names a status link. */
function Receipt(props: { company: { slug: string; name: string }; role: { id: string }; packet: RolePacket; to: string | null }) {
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
  const to = sealed?.v === 1 && sealed.roleId === job.role.id && typeof sealed.to === "string" ? sealed.to : null;
  c.header("Cache-Control", "no-store");
  return c.html(<Receipt company={job.company} role={job.role} packet={job.packet} to={to} />);
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

candidatePages.get("/c/status/:token", async (c) => {
  const db = c.get("container").db;
  const [app] = await db.select().from(applications).where(eq(applications.statusToken, c.req.param("token"))).limit(1);
  if (app && (await anonymizedFor(c.get("container"), app.candidateId))) return linkGone(c);
  if (!app) return c.notFound();
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const msgs = await db.select().from(communications).where(and(eq(communications.applicationId, app.id), eq(communications.direction, "outbound"))).orderBy(desc(communications.createdAt)).limit(5);
  const openScreen_ = (await db.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt)).limit(1)).find((s) => ["invited", "reminded", "in_progress"].includes(s.status));
  const [iv] = await db.select().from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt)).limit(1);
  const ivTz = iv?.schedulingWindow.candidateTimezone ?? cand?.location?.timezone ?? company?.timezone ?? "America/Los_Angeles";
  // What to prepare (D15): the purpose of the booked round, from the packet version this application runs on.
  const prepare = iv && iv.status === "scheduled" ? await withTenant(c.get("container").db, app.companyId, async (tx) => (await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1))[0]?.packet.interviews.plan.find((r) => r.key === iv.roundKey)?.purpose ?? null) : null;
  const smsEnabled = c.get("container").env.SMS_ENABLED;
  const smsOn = !!cand?.consent.sms?.granted && !cand?.preferences.smsOptOut;
  const poolOptOut = !!cand?.preferences.talentPoolOptOut;
  const next: Record<string, string> = {
    applied: "We are confirming your application now.",
    received: "Your application is in. We are checking the basics.",
    eligible: "The hiring team is reviewing your application. You will hear from them either way.",
    ineligible: "One of the eligibility answers did not match what this role needs. If that was a mistake, reply to our email and a person will look.",
    triaged: "The hiring team is reviewing your application. You will hear from them either way.",
    screen_invited: "We sent you a short screening conversation to complete when convenient. The link is below.",
    screening: "Finish the screening conversation whenever you are ready. The link is below.",
    screen_complete: "Thanks for completing the screen. The team is reviewing.",
    interview_recommended: "The team would like to talk with you. They will contact you about a time.",
    interview_scheduled: "Your interview is scheduled. Details were sent to you.",
    interview_complete: "Thanks for interviewing. The team is deciding.",
    debrief: "The team is deciding.",
    finalist: "You are a finalist. We will be in touch soon.",
    offer_sent: "Check your messages for the offer.",
    accepted: "Welcome aboard.",
    hired: "You are on the team.",
    rejected: poolOptOut ? "Thank you for applying. This role did not work out." : "Thank you for applying. This role did not work out, and we will keep you in mind for future openings unless you ask us not to.",
    withdrawn: "You withdrew this application. Reply to any of our emails to reactivate it.",
    talent_pool: poolOptOut ? "This role is not moving forward for you. As you asked, nobody will contact you about future openings." : "We are keeping you in mind for future openings.",
  };
  return c.html(
    <Layout title={`Your application at ${company?.name ?? ""}`}>
      <p class="eyebrow">{company?.name ? `${company.name} · ` : ""}Your application</p>
      <h1>{role?.title}</h1>
      <div class="card status">
        <div><span>Status</span><strong>{STAGE_LABEL[app.stage]}</strong></div>
        <div><span>Applied</span><span>{new Date(app.createdAt).toLocaleDateString()}</span></div>
        <div><span>Last update</span><span>{new Date(app.stageChangedAt).toLocaleDateString()}</span></div>
      </div>
      <h2>What happens next</h2>
      <p>{next[app.stage] ?? "We will keep you posted."}</p>
      {openScreen_ ? <a class="btn" href={`/c/screen/${openScreen_.token}`}>{openScreen_.status === "in_progress" ? "Continue the screening conversation" : "Start the screening conversation"}</a> : null}
      {iv && iv.status === "scheduling" && iv.scheduleToken && iv.offeredSlots.length ? <div class="card"><strong>Pick a time for your {iv.title.toLowerCase()}.</strong><p>{company?.name} would like to interview you.</p><a class="btn" href={`/c/schedule/${iv.scheduleToken}`}><Icon name="calendar" />Choose a time</a></div> : null}
      {iv && iv.status === "scheduled" && iv.startsAt && iv.scheduleToken ? <div class="card"><strong>Your interview: {iv.title}</strong><p>{new Intl.DateTimeFormat("en-US", { timeZone: ivTz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iv.startsAt))}{iv.meetingUrl ? <span> · <a href={iv.meetingUrl}>Join link</a></span> : null}</p>{prepare ? <p><strong>What to prepare:</strong> {prepare} Bring examples from your own work, and any questions you have for the team.</p> : null}<p><a href={`/c/schedule/${iv.scheduleToken}/confirmed`}>Details, calendar file, reschedule or cancel</a></p></div> : null}
      {msgs.length ? <h2>Messages we sent you</h2> : null}
      {msgs.map((m) => <div class="card"><strong>{m.subject}</strong><p class="pre">{m.bodyText}</p></div>)}
      {c.req.query("withdrawn") === "1" ? <div class="card"><strong>Your application is withdrawn.</strong><p>Thank you for your time. Reply to any of our emails if you change your mind.</p></div> : null}
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
      {!["hired", "withdrawn", "rejected", "talent_pool", "declined"].includes(app.stage) ? (
        <form method="post" action={`/c/status/${app.statusToken}/withdraw`} class="card">
          <p><strong>No longer interested?</strong> One click withdraws your application; we will confirm by email and keep your information only as long as the law requires.</p>
          <label class="check"><input type="checkbox" name="confirm" value="yes" required /> Yes, withdraw my application.</label>
          <button class="btn secondary" type="submit">Withdraw my application</button>
        </form>
      ) : null}
      {/* Wave 0 item 0.11: the talent-pool choice is one click either way, and it only ever affects future roles. */}
      {poolOptOut ? (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card">
          <p><strong>Future roles:</strong> you asked us not to keep your details for future roles, so nobody will contact you about other openings at {company?.name}.</p>
          <input type="hidden" name="pref" value="in" />
          <button class="btn secondary" type="submit">Keep me for future roles again</button>
        </form>
      ) : (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card">
          <p><strong>Future roles:</strong> {company?.name} may keep your details to tell you about other openings later. This does not change your current application.</p>
          <button class="btn secondary" type="submit">Don't keep me for future roles</button>
        </form>
      )}
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
        <li>Ask to talk to a person instead of an automated conversation by replying HUMAN.</li>
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
/* Screening conversation (Slice 2): server-rendered web chat, no JavaScript required, one question at a time.  */
/* ------------------------------------------------------------------------------------------------------------ */

async function loadScreenByToken(db: Vars["Variables"]["container"]["db"], token: string) {
  const [scr] = await db.select().from(screens).where(eq(screens.token, token)).limit(1);
  if (!scr) return null;
  const [app] = await db.select().from(applications).where(eq(applications.id, scr.applicationId)).limit(1);
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!cand || !role || !company || !pv) return null;
  return { screen: scr, app, candidate: cand, role, company, packet: pv.packet };
}

/**
 * The conversation's own styles, on top of the page stylesheet: the assistant's messages on the left in a sunken box,
 * the candidate's in near-black on the right (as in the application), and a quiet progress bar. Buttons and their
 * secondary look come from the page stylesheet, like every other candidate page.
 */
export const SCREEN_CSS = `
.thread { display: flex; flex-direction: column; gap: 10px; margin: 20px 0; }
.msg { max-width: 88%; padding: 12px 16px; border-radius: 16px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.assistant { align-self: flex-start; background: var(--ground); border: 1px solid var(--line); color: var(--ink); border-bottom-left-radius: 6px; }
.msg.candidate { align-self: flex-end; background: var(--ink); color: var(--ground); border-bottom-right-radius: 6px; }
.msg.system { align-self: center; background: transparent; color: var(--ink-3); font-size: 14px; }
.progress { display: flex; align-items: center; gap: 12px; margin-top: 8px; color: var(--ink-3); font-size: 14px; font-variant-numeric: tabular-nums; }
.bar { flex: 1; height: 6px; overflow: hidden; border-radius: var(--r-pill); background: var(--surface-2); }
.bar i { display: block; height: 100%; border-radius: inherit; background: var(--ink); }
`;

candidatePages.get("/c/screen/:token", async (c) => {
  const container = c.get("container");
  const b = await loadScreenByToken(container.db, c.req.param("token"));
  if (!b) return c.notFound();
  const { candidate, company, packet, app } = b;
  let screen = b.screen;
  const active = ["invited", "reminded", "in_progress"].includes(screen.status);
  if (active && !screen.transcript.some((t) => t.role === "assistant")) {
    await openScreen(container.db, company.id, screenDeps(container), { screenId: screen.id, actor: { kind: "system", id: "screen_web" } });
    screen = (await container.db.select().from(screens).where(eq(screens.id, screen.id)).limit(1))[0];
  }
  // A screen that opened with the open questions counts them too, so "x of N" matches the "N questions" the invitation promised.
  const total = focusedPacket(packet, screen.progress).screening.questions.length;
  const answered = Object.keys(answersOf(screen)).length;
  const err = c.req.query("error");
  const notice = noticesFor(["*"]).find((n) => n.key === "ai_use");
  const calendar = await loadBusinessCalendar(container.db);
  return c.html(
    <Layout title={`Screening: ${packet.identity.title} at ${company.name}`} extraCss={SCREEN_CSS}>
      <p class="eyebrow">{company.name} · {packet.identity.title}</p>
      <h1>A few questions, {candidate.firstName}</h1>
      <p class="lead">About {packet.screening.maxMinutes} minutes, one question at a time. You can stop and come back any time; this page remembers where you were.</p>
      {screen.status === "expired" ? <div class="err">This screening link has expired. Reply to any of our emails and a person will pick it up with you.</div> : null}
      {screen.status === "human_requested" ? <div class="card"><strong>A person will follow up.</strong><p>Someone from {company.name}'s hiring team has your conversation and will reach out {humanResponseExpectation(new Date(), calendar)}.</p></div> : null}
      {screen.status === "completed" ? <div class="card"><strong>Thanks, that is everything.</strong><p>The hiring team reviews your answers and you hear back within a few days. <a href={`/c/status/${app.statusToken}`}>Check your status</a> any time.</p></div> : null}
      {screen.status === "abandoned" ? <div class="card">This application was withdrawn. Reply to any of our emails if you change your mind.</div> : null}
      <div class="thread">
        {screen.transcript.map((t) => <div class={`msg ${t.role}`}>{t.content}</div>)}
      </div>
      {active && withdrawPending(screen.transcript) ? (
        // WITHDRAW asked first (Wave 0 item 0.7): nothing is withdrawn until the candidate presses the first button.
        <div class="card" role="status">
          <strong>Do you want to withdraw your application?</strong>
          <p>Withdrawing ends this conversation and your application for {packet.identity.title}. To keep going instead, just type your answer below.</p>
          <form method="post" action={`/c/screen/${screen.token}/withdraw`} class="actions">
            <button class="btn" type="submit" name="confirm" value="yes">Yes, withdraw my application</button>
            <button class="btn secondary" type="submit" name="confirm" value="no">No, keep my application</button>
          </form>
        </div>
      ) : null}
      {active ? (
        <>
          <div class="progress"><span>{answered} of {total} answered</span><span class="bar"><i style={`width:${Math.round((answered / Math.max(1, total)) * 100)}%`} /></span></div>
          {err === "empty" ? <div class="err">Please type an answer first.</div> : err === "trouble" ? <div class="err">Something went wrong on our end. Please send that again in a minute.</div> : null}
          <form method="post" action={`/c/screen/${screen.token}`}>
            <label for="message">Your answer</label>
            <textarea id="message" name="message" rows={3} required autofocus></textarea>
            <div class="actions">
              <button class="btn" type="submit">Send</button>
            </div>
          </form>
          <form method="post" action={`/c/screen/${screen.token}/human`} class="actions">
            <button class="btn secondary" type="submit">Talk to a person instead</button>
          </form>
        </>
      ) : null}
      <p class="notice">{notice?.text}</p>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});

candidatePages.post("/c/screen/:token", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const b = await loadScreenByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  const body = await c.req.parseBody();
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) return c.redirect(`/c/screen/${b.screen.token}?error=empty`);
  const result = await runScreenTurn(container.db, b.company.id, screenDeps(container), { screenId: b.screen.id, message, channel: "web", actor: { kind: "system", id: "screen_web" } });
  await container.kick();
  return c.redirect(`/c/screen/${b.screen.token}${result.kind === "error" ? "?error=trouble" : ""}`);
});

candidatePages.post("/c/screen/:token/human", rateLimit(POLICIES.screenHuman), async (c) => {
  const container = c.get("container");
  const b = await loadScreenByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (["invited", "reminded", "in_progress"].includes(b.screen.status)) {
    await withTenant(container.db, b.company.id, async (tx) => requestHuman(tx, screenDeps(container), { screenId: b.screen.id, reason: "candidate pressed 'Talk to a person'", actor: { kind: "candidate", id: b.candidate.id }, reply: `Understood. A person from ${b.company.name} will follow up with you ${humanResponseExpectation(new Date(), await loadBusinessCalendar(tx))}.`, replyChannel: "web" }));
    await container.kick();
  }
  return c.redirect(`/c/screen/${b.screen.token}`);
});

/**
 * The answer to "do you want to withdraw?" on the web (Wave 0 item 0.7): `confirm=yes` withdraws the application and
 * closes the conversation, `confirm=no` keeps it and picks up where it was. The link itself is the proof, as on the
 * status page; a screen that already ended is left as it is.
 */
candidatePages.post("/c/screen/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const b = await loadScreenByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (await anonymizedFor(container, b.candidate.id)) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.confirm === "yes" || body.confirm === "no") {
    await withTenant(container.db, b.company.id, (tx) => answerWithdrawPrompt(tx, screenDeps(container), { screenId: b.screen.id, confirm: body.confirm === "yes", channel: "web", actor: { kind: "candidate", id: b.candidate.id } }));
    await container.kick();
  }
  return c.redirect(`/c/screen/${b.screen.token}`);
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
  const active = !["hired", "withdrawn", "rejected", "talent_pool", "declined"].includes(app.stage);
  if (active) {
    await withTenant(container.db, app.companyId, async (tx) => {
      const actor = { kind: "candidate" as const, id: app.candidateId };
      await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "withdrawn", by: "candidate", actor, reason: "withdrawn from the status page" });
      await emit(tx, { type: "application.withdrawn", companyId: app.companyId, actor, subject: { type: "application", id: app.id }, payload: { via: "status_page" } });
      const open = await tx.select().from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, ["invited", "reminded", "in_progress"])));
      for (const s of open) {
        await tx.update(screens).set({ status: "abandoned" }).where(eq(screens.id, s.id));
        await emit(tx, { type: "screen.abandoned", companyId: app.companyId, actor, subject: { type: "screen", id: s.id }, payload: { reason: "withdrawn" } });
        await container.engine.signal(tx, { companyId: app.companyId, key: `screen:${s.id}:completed`, payload: { withdrawn: true } });
      }
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
 * changes nothing. `pref=in` ("Keep me for future roles again") takes the choice back, with nothing sent.
 */
candidatePages.post("/c/status/:token/talent-pool", rateLimit(POLICIES.talentPoolPref), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  if (body.pref === "in") await withTenant(container.db, app.companyId, (tx) => optBackIntoTalentPool(tx, { application: app }));
  else if (await withTenant(container.db, app.companyId, (tx) => optOutOfTalentPool(tx, container, { application: app, source: "status_page" }))) await container.kick();
  return c.redirect(`/c/status/${app.statusToken}`);
});
