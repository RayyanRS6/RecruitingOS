/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { ApplyRequest, ApplySource, MAX_RESUME_BYTES, inspectResumeFile, trialStanding, type DraftRolePacket, type FormAnswers, type FormQuestion, type RolePacket } from "@ros/contracts";
import { ON_FILE_NOTICE, ON_FILE_SOFTWARE_LINE, candidateNotices, closeOutDayWords, closeOutDueAt, emit, onFileFormLine, onFileReceiptLine, openPayload, sealPayload, type Notice } from "@ros/core";
import { randomToken, uuidv7, withTenant } from "@ros/db";
import { refFor } from "@ros/integrations";
import { DISCARD_OBJECT_JOB_KIND } from "@ros/workflows";
import { UPLOAD_GRANT_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, checkUploadIntent, quarantineKey, type UploadGrantPayload } from "../uploads";
import { readAppCookie, setAppCookie } from "../cookies";
import { clientIp, type Vars } from "../middleware/session";
import { reportUnhandled } from "../middleware/errors";
import type { Container } from "../container";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { createApplication, markUploadUsed, uploadAlreadyUsed, withNewApplication, type ResumeInput as ResumeUpload } from "../services/applications";
import { formOpenedBefore, lateApplicationAllowed, sealFormOpened } from "../services/closing-date";
import { contactLineFor, type ContactLine } from "../services/company-settings-profile";
import { FORM_MINUTES, type ApplyFlowView } from "../services/job-preview";
import { acceptingApplications, applyFlowOf, jobNotices, jobTakesApplications, loadJob, maskEmail, type Job } from "./candidate-shared";
import { Icon } from "./icons";
import { JobFacts, publicPay } from "./job-facts";
import { HelpLine, PreviewNote, type PreviewInfo } from "./job-page";
import { Layout, currentNonce } from "./layout";
import { withPlainQuestionHelp } from "./question-help";

/**
 * Applying: the application form, shared by the public page and the team's preview (pages/preview.tsx); the routes that
 * show it, take a direct upload and take the application; and the receipt. Mounted on the candidate pages by
 * pages/candidate.tsx.
 *
 * The form asks who they are, their resume, the job's screening questions, and the acknowledgment. Nothing is read by AI
 * before Send, and no answer holds anyone. On a job past its plan's candidates per job (`flow` "on_file") the form is the
 * same, with the line that says so before Send beside the required notices, which keep every word.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as applyPages };

/* ------------------------------------------------------------------------------------------------------------ */
/* The application form                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What a re-rendered form keeps: every typed value, every answer (by question key), the acknowledgment, which fields
 * were missing, and a resume the browser already uploaded directly (its sealed grant goes back into the form, so the
 * file stays attached). A file posted inside the form itself cannot be put back by any browser: `resumeLost` makes the
 * page say so instead of claiming everything is still there.
 */
export type ApplyFormState = { values: Record<string, string>; answers: Record<string, string>; acknowledged: boolean; missing: string[]; resume: { grant: string; filename: string } | null; resumeLost: boolean };

/** The sentence a re-shown form ends its error with: true about what is still on the page. */
export function keptSentence(resumeLost: boolean): string {
  return resumeLost ? "Everything you typed is still here, but please attach your resume again." : "Everything you entered is still here.";
}

/**
 * The notice versions recorded as shown: the notices the page renders as text. Computed by the server on every render
 * and again on the submission, never taken from the browser.
 */
export function noticeVersionsFor(notices: Notice[]): string[] {
  return candidateNotices(notices).map((n) => `${n.key}@${n.version}`);
}

export type ApplyFormProps = {
  company: { slug: string; name: string; contact: ContactLine };
  role: { id: string };
  packet: DraftRolePacket;
  /** Every notice for the jurisdictions; the form itself decides what is rendered (candidateNotices). */
  notices: Notice[];
  privacyEmail: string;
  /** The sealed "form opened at" value (services/closing-date.ts): a form opened before the closing date may still be sent. */
  formOpened: string;
  /** "on_file": the job is past its plan's candidates per job, and the form says so before Send. */
  flow: ApplyFlowView;
  /** `apply`: where the form sends the application. A preview has none: its form sends nothing. */
  links: { job: string; uploadIntent: string; apply?: string };
  /** Where they came from (`?src=` on the job page), carried in the form and recorded with the application. */
  source?: string | null;
  error?: string;
  state?: Partial<ApplyFormState>;
  preview?: PreviewInfo;
};

/** The field a screening question's answer is posted in. */
const fieldOf = (q: Pick<FormQuestion, "key">): string => `q_${q.key}`;

/**
 * The transparency block sits above the submit button: who runs the process, what is collected and why, who may see it,
 * how to exercise the candidate's rights, the privacy address, the link to the notice, and the affirmative
 * acknowledgment. Plain words, short sentences, nothing pre-checked.
 *
 * First view: three short lines and the privacy link; the full notice, every word of it (its own privacy link and the
 * notices included), sits under "Read the full notice", above the box that says the full notice was read (its words name
 * the fold). A form sent back without that box ticked opens the notice. `onFile`: the job is past its limit, and the
 * form says so before Send, beside those notices and never in place of them. Its words are DRAFT WORDING PENDING COUNSEL
 * (packages/core/src/candidate-lock.ts), recorded among the notices shown.
 */
function TransparencyBlock(props: { company: { name: string }; notices: Notice[]; privacyEmail: string; acknowledged: boolean; missing: boolean; resumeLost: boolean; onFile: boolean }) {
  return (
    <section class="card" aria-labelledby="before-you-send">
      <h2 id="before-you-send">Before you send</h2>
      <ul class="steps">
        <li>People at {props.company.name} make every hiring decision.</li>
        <li>Software helps organize applications and works out a match score.{props.onFile ? ` ${ON_FILE_SOFTWARE_LINE}` : ""}</li>
        <li>You can ask for a person at any time.</li>
      </ul>
      {props.onFile ? <p class="notice">{onFileFormLine(props.company.name)}</p> : null}
      <p><a href="/privacy">Read how we handle your information</a></p>
      <details class="more" open={props.missing || undefined}>
        <summary>Read the full notice</summary>
        <p><strong>{props.company.name}</strong> runs this hiring process and is the employer. People at {props.company.name} make every hiring decision. Software helps organize and summarize applications, and works out a match score from what you send, checked against the job's requirements; the team sees what the score is based on, and a person always decides.</p>
        {props.onFile ? <p>{ON_FILE_SOFTWARE_LINE}</p> : null}
        <p><strong>What we collect:</strong> your name, your email, your phone number if you give one, where you are based, your resume or your answers about your work, and your answers to the questions above.</p>
        <p><strong>Why:</strong> to consider you for this position and to contact you about it. Nothing else.</p>
        <p><strong>Who can see it:</strong> the hiring team at {props.company.name}; an Identified Talent Solutions recruiter only if {props.company.name} brings one in to help; and the companies that run this service for us: hosting, file storage, email delivery, and the AI service that helps organize applications. Each does only its own job; the privacy page linked below says what each one does.</p>
        <p><strong>Your choices:</strong> after you apply, we email you a link to your own status page, where you can ask for a copy of your information, correct it, withdraw your application, or delete your information. You can also email <a href={`mailto:${props.privacyEmail}`}>{props.privacyEmail}</a> at any time. A person handles every request.</p>
        <p><a href="/privacy">Read how we handle your information</a></p>
        {props.notices.map((n) => <p class="notice">{n.text}</p>)}
      </details>
      <label class="check" for="acknowledged">
        <input id="acknowledged" type="checkbox" name="acknowledged" value="yes" required checked={props.acknowledged} aria-invalid={props.missing ? "true" : undefined} aria-describedby={props.missing ? "acknowledged-error" : undefined} />
        <span>I have read the full notice above and I understand that people, not software, make the hiring decisions.</span>
      </label>
      {props.missing ? <p class="err" id="acknowledged-error">Please tick this box to send your application. {keptSentence(props.resumeLost)}</p> : null}
    </section>
  );
}

/** The resume's own field, with the line that says what happened to a file already sent. */
function ResumeField(props: { kept: { filename: string } | null; resumeLost: boolean; invalid: boolean }) {
  return (
    <>
      <label for="resume">Resume (PDF, Word, or text; up to 8 MB, or up to 4 MB without JavaScript)</label>
      <input id="resume" type="file" name="resume" required={!props.kept || undefined} aria-invalid={props.invalid ? "true" : undefined} accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" />
      <small id="upload-note" aria-live="polite">{props.kept ? `Your resume ${props.kept.filename} is still attached. Choose a file only if you want to replace it.` : props.resumeLost ? "Your resume is not attached any more. Please choose the file again." : ""}</small>
    </>
  );
}

/** One screening question: Yes and No, the job's own choices, or a number. */
function QuestionItem(props: { q: FormQuestion; n: number; answer: string | undefined; invalid: boolean }) {
  const { q } = props;
  const field = fieldOf(q);
  const helpId = `${field}-why`;
  const num = <span class="q-num" aria-hidden="true">{String(props.n).padStart(2, "0")}</span>;
  const mark = q.required ? <span class="req"> (required)</span> : null;
  const help = q.help ? <small id={helpId}>{q.help}</small> : null;
  if (q.kind === "number") {
    return (
      <li data-field={field}>
        <label class="question-label" for={field}>{num}{q.question}{mark}</label>
        {help}
        <div class="number-row">
          <input id={field} type="number" name={field} inputmode="decimal" step="any" min={q.min} max={q.max} required={q.required || undefined} value={props.answer ?? ""} aria-invalid={props.invalid ? "true" : undefined} aria-describedby={q.help ? helpId : undefined} />
          {q.unit ? <span>{q.unit}</span> : null}
        </div>
      </li>
    );
  }
  // A yes/no answer is sent as "yes" or "no"; a choice as the option's own words.
  const options = q.kind === "yes_no" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : q.options.map((o) => ({ value: o, label: o }));
  return (
    <li data-field={field}>
      <fieldset aria-describedby={q.help ? helpId : undefined}>
        <legend class="question-legend">{num}{q.question}{mark}</legend>
        {help}
        <div class={q.kind === "yes_no" ? "choices pair" : "choices"}>
          {options.map((o) => (
            <label class="check slot">
              <input type="radio" name={field} value={o.value} required={q.required || undefined} checked={props.answer === o.value || undefined} aria-invalid={props.invalid ? "true" : undefined} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </li>
  );
}

/** The fields themselves, shared by the real form and the preview's form that sends nothing. */
function ApplyFields(props: ApplyFormProps & { questions: FormQuestion[] }) {
  const v = props.state?.values ?? {};
  const answers = props.state?.answers ?? {};
  const missing = new Set(props.state?.missing ?? []);
  const invalid = (field: string) => (missing.has(field) ? "true" : undefined);
  return (
    <>
      <section class="card resume-card" aria-labelledby="resume-title">
        <h2 id="resume-title">Your resume</h2>
        <ResumeField kept={props.state?.resume ?? null} resumeLost={!!props.state?.resumeLost} invalid={missing.has("resume")} />
      </section>
      <h2 id="details-title">Your details</h2>
      <label for="firstName">First name</label>
      <input id="firstName" type="text" name="firstName" required autocomplete="given-name" value={v.firstName ?? ""} aria-invalid={invalid("firstName")} />
      <label for="lastName">Last name</label>
      <input id="lastName" type="text" name="lastName" required autocomplete="family-name" value={v.lastName ?? ""} aria-invalid={invalid("lastName")} />
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email" value={v.email ?? ""} aria-invalid={invalid("email")} />
      <label for="phone">Mobile phone (optional)</label>
      <input id="phone" type="tel" name="phone" autocomplete="tel" value={v.phone ?? ""} aria-invalid={invalid("phone")} />
      {props.questions.length ? (
        <section class="quick" aria-labelledby="questions-title">
          <h2 id="questions-title">Questions from {props.company.name}</h2>
          <ol class="questions">
            {props.questions.map((q, i) => <QuestionItem q={q} n={i + 1} answer={answers[q.key]} invalid={missing.has(fieldOf(q))} />)}
          </ol>
        </section>
      ) : null}
      <TransparencyBlock company={props.company} notices={candidateNotices(props.notices)} privacyEmail={props.privacyEmail} acknowledged={!!props.state?.acknowledged} missing={missing.has("acknowledged")} resumeLost={!!props.state?.resumeLost} onFile={props.flow === "on_file"} />
    </>
  );
}

/** The application form: the job's facts, the pre-apply help line, the fields, and (outside a preview) its script. */
export function ApplyFormPage(props: ApplyFormProps) {
  const { preview } = props;
  const questions = withPlainQuestionHelp(props.packet).formQuestions;
  return (
    <Layout title={`${preview ? "Preview: apply" : "Apply"}: ${props.packet.identity.title} at ${props.company.name}`} noindex={!!preview} extraCss={APPLY_CSS}>
      {preview ? <PreviewNote preview={preview} /> : null}
      <p class="back"><a href={props.links.job}><Icon name="arrow-left" />Back to the job</a></p>
      {/* The facts of the job stay in view while applying, pay included wherever the page must show it. */}
      <h1>Apply: {props.packet.identity.title}</h1>
      <JobFacts packet={props.packet} pay={publicPay(props.packet, props.notices)} />
      <p class="lead">A short form for {props.company.name}, about {FORM_MINUTES} minutes. No cover letter needed.</p>
      <HelpLine contact={props.company.contact} class="notice" />
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      {preview ? (
        <div class="form-preview">
          <fieldset disabled>
            <legend class="sr-only">The form as candidates see it; it sends nothing here</legend>
            <ApplyFields {...props} questions={questions} />
            <button class="btn" type="button" disabled>Send my application</button>
          </fieldset>
        </div>
      ) : (
        <form method="post" action={props.links.apply} enctype="multipart/form-data" data-upload-intent={props.links.uploadIntent}>
          <input type="text" name="website" tabindex={-1} autocomplete="off" class="trap" aria-label="Leave this field empty" />
          <input type="hidden" name="uploadGrant" value={props.state?.resume?.grant ?? ""} />
          <input type="hidden" name="formOpened" value={props.formOpened} />
          {props.source ? <input type="hidden" name="src" value={props.source} /> : null}
          <ApplyFields {...props} questions={questions} />
          {/* This page showed the line before Send, so the application records it among the notices shown (`onFileShown`). */}
          {props.flow === "on_file" ? <input type="hidden" name="onFileShown" value="yes" /> : null}
          <button class="btn" type="submit">Send my application</button>
        </form>
      )}
      {preview ? null : <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_UPLOAD_JS }} />}
    </Layout>
  );
}

/**
 * The form's own styles, passed as the page's styles: the shared tokens only, no button rules and no motion. The
 * resume's card (its file field is the page stylesheet's dashed drop area), the screening questions as numbered tiles
 * with Yes and No as two pills, and "Before you send" as the lavender consent box with the acknowledgment on a white row
 * inside it.
 */
export const APPLY_CSS = `
.resume-card input[type=file] { margin-bottom: 4px; }
ol.questions { display: grid; gap: 12px; margin: 16px 0 0; padding: 0; list-style: none; }
ol.questions > li { padding: 18px 20px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--ground); }
ol.questions legend.question-legend, ol.questions .question-label { display: block; margin: 0 0 6px; color: var(--ink); font-size: 16px; font-weight: 600; }
ol.questions .q-num { margin-right: 10px; color: var(--accent-ink); font: 400 13px/1 var(--mono); letter-spacing: 0.06em; }
ol.questions .req { color: var(--ink-3); font-size: 14px; font-weight: 400; }
.choices { display: grid; gap: 8px; margin: 12px 0 0; }
.choices.pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.choices .slot { min-height: 48px; margin: 0; }
.choices.pair .slot { justify-content: center; border-radius: var(--r-pill); }
.number-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.number-row input[type=number] { max-width: 220px; }
.number-row span { color: var(--ink-2); }
main .card[aria-labelledby="before-you-send"] { border-color: var(--line-tint); background: var(--tint); }
[aria-labelledby="before-you-send"] .check { padding: 14px 16px; border: 1px solid var(--line-tint); border-radius: var(--r-control); background: var(--surface); }
[aria-labelledby="before-you-send"] .notice { background: var(--surface); }
`;

/**
 * Direct-to-storage upload: with script, the resume goes from the browser straight to storage under a short-lived,
 * single-object authorization and the form carries only a sealed grant; without script, or if the upload fails, the form
 * posts the file itself. Plain ES5, no inline handlers (the policy forbids them), no third-party code, nothing about the
 * person leaves the page except the file's name, size and type (and the form's own sealed "opened at" value, so a form
 * opened before a closing date can still upload). The button locks against a second press ("Sending…"), and a page
 * brought back from the browser's history unlocks it.
 */
export const APPLY_UPLOAD_JS = `(function(){
var form=document.querySelector('form[data-upload-intent]');if(!form||!window.fetch||!window.FormData){return;}
var input=form.querySelector('input[type=file][name=resume]');var grant=form.querySelector('input[name=uploadGrant]');var opened=form.querySelector('input[name=formOpened]');var note=document.getElementById('upload-note');
var buttons=form.querySelectorAll('button[type=submit]');
if(!input||!grant){return;}
var busy=false;
function say(t){if(note){note.textContent=t;}}
function lock(on){for(var i=0;i<buttons.length;i++){buttons[i].disabled=on;}}
window.addEventListener('pageshow',function(e){if(e.persisted){busy=false;lock(false);}});
input.addEventListener('change',function(){if(input.files&&input.files.length&&grant.value){grant.value='';say('');}});
function fallback(file){form.removeAttribute('data-upload-intent');if(file.size>4*1024*1024){say('The direct upload did not work. Files over 4 MB can only be sent by the direct upload: please try again in a moment, or choose a smaller file.');busy=false;lock(false);return;}form.submit();}
form.addEventListener('submit',function(ev){
if(busy){ev.preventDefault();return;}
var sub=ev.submitter||null;
var file=input.files&&input.files[0];
if(!file||grant.value){busy=true;if(sub){sub.textContent='Sending…';}window.setTimeout(function(){lock(true);},0);return;}
ev.preventDefault();busy=true;lock(true);say('Uploading your resume…');
fetch(form.getAttribute('data-upload-intent'),{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({filename:file.name,size:file.size,type:file.type,formOpened:opened?opened.value:''})})
.then(function(r){return r.json().then(function(j){if(!r.ok){throw new Error((j&&j.error&&j.error.message)||'The upload was refused.');}return j;});})
.then(function(j){return fetch(j.url,{method:j.method,headers:j.headers,body:file}).then(function(r){if(!r.ok){throw new Error('The upload did not complete.');}grant.value=j.grant;});})
.then(function(){input.value='';say('Resume uploaded.');if(sub){sub.textContent='Sending…';}form.submit();})
.catch(function(e){say((e&&e.message)||'The upload did not work.');fallback(file);});
});
})();`;

/* ------------------------------------------------------------------------------------------------------------ */
/* What a posted form says                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

type AnswerProblem = { field: string; question: string; problem: string };

/**
 * A posted form: the typed values, the answers the questions take (by question key: "yes" or "no", one of a choice's
 * options, or a number within its limits), the ones they do not take, the required ones left out, and the form's hidden
 * fields.
 */
export type PostedApplyForm = { values: Record<string, string>; answers: FormAnswers; shown: Record<string, string>; problems: AnswerProblem[]; unanswered: FormQuestion[]; acknowledged: boolean; grant: string; formOpened: string; website: string; source: string | null };

function bodyString(body: Record<string, unknown>) {
  return (k: string): string => {
    const v = body[k];
    if (typeof v === "string") return v;
    return Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
  };
}

/** Why a typed number is not one the question takes, in the words the error line uses; null when it is fine. */
function numberProblem(q: Extract<FormQuestion, { kind: "number" }>, typed: string): string | null {
  const cleaned = typed.replace(/[,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return "a number";
  const n = Number(cleaned);
  const range = q.min !== undefined && q.max !== undefined ? `a number from ${q.min} to ${q.max}` : null;
  if (q.min !== undefined && n < q.min) return range ?? `a number of at least ${q.min}`;
  if (q.max !== undefined && n > q.max) return range ?? `a number of at most ${q.max}`;
  return null;
}

export function postedApplyForm(body: Record<string, unknown>, questions: readonly FormQuestion[]): PostedApplyForm {
  const str = bodyString(body);
  const answers: FormAnswers = {};
  const shown: Record<string, string> = {};
  const problems: AnswerProblem[] = [];
  for (const q of questions) {
    const typed = str(fieldOf(q)).trim();
    if (!typed) continue;
    if (q.kind === "yes_no") {
      if (typed === "yes" || typed === "no") answers[q.key] = shown[q.key] = typed;
    } else if (q.kind === "choice") {
      // only an option the question offers; anything else was not typed on this page
      const option = q.options.find((o) => o === typed);
      if (option) answers[q.key] = shown[q.key] = option;
    } else {
      shown[q.key] = typed.slice(0, 40);
      const problem = numberProblem(q, typed);
      if (problem) problems.push({ field: fieldOf(q), question: q.question, problem });
      else answers[q.key] = typed.slice(0, 40);
    }
  }
  const source = ApplySource.safeParse(str("src"));
  return {
    values: { firstName: str("firstName"), lastName: str("lastName"), email: str("email"), phone: str("phone") },
    answers,
    shown,
    problems,
    unanswered: questions.filter((q) => q.required && shown[q.key] === undefined),
    acknowledged: str("acknowledged") === "yes",
    grant: str("uploadGrant"),
    formOpened: str("formOpened"),
    website: str("website"),
    source: source.success ? source.data : null,
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The receipt and the routes                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The receipt everyone sees after sending the form: new or repeat, the page is the same, and the status link only ever
 * travels by email to the address on file. The address shown is masked and carried for a short while in a sealed cookie
 * the browser cannot read, never in the URL. `by`: on a job past its plan's candidates per job, the moment they hear by
 * at the latest, as their email says.
 */
export const RECEIPT_COOKIE = "ros_applied";
const RECEIPT_PURPOSE = "application-receipt";
const RECEIPT_TTL_MS = 30 * 60_000;
type ReceiptPayload = { v: 1; roleId: string; to: string; exp: number; by?: string };

function receiptPath(slug: string, roleId: string): string {
  return `/careers/${slug}/jobs/${roleId}/applied`;
}

/** Sends the browser to the receipt, with the masked address it shows. */
function toReceipt(c: Context<Vars>, job: { company: { slug: string }; role: { id: string } }, typedEmail: string, onFile: boolean) {
  const container = c.get("container");
  const path = receiptPath(job.company.slug, job.role.id);
  const now = container.engine.clock().getTime();
  const payload: ReceiptPayload = { v: 1, roleId: job.role.id, to: maskEmail(typedEmail), exp: now + RECEIPT_TTL_MS, ...(onFile ? { by: closeOutDueAt(new Date(now)).toISOString() } : {}) };
  setAppCookie(c, RECEIPT_COOKIE, sealPayload(RECEIPT_PURPOSE, payload, container.env.SESSION_SECRET), { path, maxAge: RECEIPT_TTL_MS / 1000 });
  return c.redirect(path);
}

/** Without JavaScript the resume travels inside the form itself, which the platform refuses above a few megabytes; this cap gives that case a plain answer. */
export const NO_SCRIPT_MAX_RESUME_BYTES = 4 * 1024 * 1024;
/** How long a directly uploaded file waits for its application before it is removed. */
const UNSENT_UPLOAD_KEEP_MS = 24 * 3600_000;

/** The addresses the form uses, all under the job's own. */
function applyLinks(job: Job) {
  const base = `/careers/${job.company.slug}/jobs/${job.role.id}`;
  return { job: base, uploadIntent: `${base}/upload-intent`, apply: `${base}/apply` };
}

/** Everything the form needs that does not change between showing it and showing it again. */
function applyFormFor(container: Container, job: Job, flow: ApplyFlowView, source: string | null): Omit<ApplyFormProps, "formOpened"> {
  return {
    company: { slug: job.company.slug, name: job.company.name, contact: contactLineFor(job.company.settings, container.env) },
    role: { id: job.role.id },
    packet: job.packet,
    notices: jobNotices(job.packet, job.company),
    privacyEmail: container.env.PRIVACY_EMAIL,
    flow,
    links: applyLinks(job),
    source,
  };
}

/**
 * Whether this submission (or upload) is taken: while the job takes applications, and for a while after its closing date
 * passed when the form was opened before it (services/closing-date.ts). A job a person paused or closed takes nothing
 * new. Once the company's trial has ended a form is still taken for the same while when it was opened before the trial's
 * end (`trialGrace`): someone part-way through applying finishes.
 */
function admits(container: Container, job: Job, formOpened: string | null | undefined): { ok: boolean; late: boolean; trialGrace: boolean } {
  const { role } = job;
  const now = container.engine.clock();
  const late = acceptingApplications(role) ? false : lateApplicationAllowed({ role, sealed: formOpened, secret: container.env.SESSION_SECRET, now });
  if (!acceptingApplications(role) && !late) return { ok: false, late: false, trialGrace: false };
  const trial = trialStanding(job.company, now);
  if (!trial?.ended || !trial.endsAt) return { ok: true, late, trialGrace: false };
  const trialGrace = formOpenedBefore({ sealed: formOpened, roleId: role.id, secret: container.env.SESSION_SECRET, moment: new Date(trial.endsAt), now });
  return { ok: trialGrace, late, trialGrace };
}

/** The upload a form carries, when its grant still opens and is for this company and job. */
function heldUpload(container: Container, job: Job, token: string): UploadGrantPayload | null {
  const g = token ? container.uploadGrants.open(token, container.engine.clock()) : null;
  return g && g.companyId === job.company.id && g.roleId === job.role.id ? g : null;
}

/** A file posted inside the form (no script), when there is one. */
function postedFile(body: Record<string, unknown>): File | null {
  const f = body.resume;
  return f && typeof f === "object" && "arrayBuffer" in f && (f as File).size > 0 ? (f as File) : null;
}

const UPLOAD_EXPIRED = "Your uploaded resume could not be attached (the upload expired). Please attach the file again.";

candidatePages.get("/careers/:slug/jobs/:roleId/apply", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job || !jobTakesApplications(job, container.engine.clock())) return c.notFound();
  // Funnel measurement without identity: a random per-visit reference, no candidate data, no client script.
  void container.integrations.analytics.capture({ name: "application_started", subjectRef: randomToken(12), companyRef: refFor(job.company.id, container.integrations.analyticsSalt), at: new Date().toISOString(), properties: { source: "careers_page" } }).catch(() => undefined);
  const source = ApplySource.safeParse(c.req.query("src"));
  return c.html(<ApplyFormPage {...applyFormFor(container, job, await applyFlowOf(container, job), source.success ? source.data : null)} formOpened={sealFormOpened(container.env.SESSION_SECRET, job.role.id, container.engine.clock())} />);
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
  if (!job || !admits(container, job, typeof opened === "string" ? opened : null).ok) return c.json({ error: { code: "not_found", message: "This position is not taking new applications right now." } }, 404);
  const intent = checkUploadIntent(raw);
  if (!intent.ok) return c.json({ error: { code: "invalid_file", message: intent.error } }, 400);
  const uploadId = uuidv7();
  const key = quarantineKey(job.company.id, job.role.id, uploadId, intent.extension);
  const now = container.engine.clock();
  // Before there can be a file: someone may upload and leave. Until an application holds the file it has no row, so nobody
  // could find it to remove it; it goes a day later unless an application holds it by then (the discard job checks).
  await container.engine.enqueue(container.db, { kind: DISCARD_OBJECT_JOB_KIND, payload: { companyId: job.company.id, key }, runAt: new Date(now.getTime() + UNSENT_UPLOAD_KEEP_MS) });
  const upload = await container.integrations.storage.createUploadUrl(key, { contentType: intent.mime, expiresSeconds: UPLOAD_URL_TTL_SECONDS });
  const grant = container.uploadGrants.seal({ v: 1, companyId: job.company.id, roleId: job.role.id, uploadId, key, filename: intent.filename, mime: intent.mime, size: intent.size, exp: Math.floor(now.getTime() / 1000) + UPLOAD_GRANT_TTL_SECONDS });
  await withTenant(container.db, job.company.id, (tx) => emit(tx, { type: "document.upload_authorized", companyId: job.company.id, actor: { kind: "candidate", id: "applicant" }, subject: { type: "role", id: job.role.id }, payload: { uploadId, extension: intent.extension, sizeBytes: intent.size } }));
  return c.json({ uploadId, url: upload.url, method: upload.method, headers: upload.headers, grant, expiresAt: upload.expiresAt, maxBytes: MAX_RESUME_BYTES });
});

/** Said when an application could not be stored (a job's lock that timed out, above all): nothing was sent, and sending it again will do. */
export const NOT_SENT_LINE = "Your application was not sent: something went wrong on our end. Please send it again in a minute.";

/** What a post of the form can show if it fails: the form again, once the post knows what was typed; `committed` once it was stored. */
type FormAgain = { again?: (error: string) => Response | Promise<Response>; committed?: boolean };

/**
 * The form posts by navigation, so whatever goes wrong before an application is stored must not answer with the API's
 * JSON, which is all the browser would show: the form comes back with what was typed and the line that it was not sent,
 * or, before the form can be drawn, a page that says the same. Logged and reported as the API does what nothing handled.
 * Once stored it was sent, so what fails after that (only an inline worker's drain) is answered as it always was.
 */
async function formPost(c: Context<Vars>, send: (drawn: FormAgain) => Promise<Response>): Promise<Response> {
  const drawn: FormAgain = {};
  try {
    return await send(drawn);
  } catch (err) {
    if (drawn.committed) throw err;
    reportUnhandled(err, c);
    if (drawn.again) return drawn.again(NOT_SENT_LINE);
    return c.html(<NotSent href={`/careers/${encodeURIComponent(c.req.param("slug") ?? "")}/jobs/${encodeURIComponent(c.req.param("roleId") ?? "")}/apply`} />, 500);
  }
}

/** Before the form could be drawn again (the job, or the post itself, could not be read): the same line, and the way back to the form. */
function NotSent(props: { href: string }) {
  return (
    <Layout title="Not sent">
      <h1>Not sent</h1>
      <div class="card" role="alert"><p>{NOT_SENT_LINE}</p></div>
      <p><a class="btn secondary" href={props.href}>Back to the form</a></p>
    </Layout>
  );
}

/**
 * "Send my application". A resume is required; a required question left out, a number a question does not take or a
 * missing acknowledgment brings the form back with what was typed. A second application from the same address creates
 * nothing; the page then shows the same receipt, and only the mailbox learns more.
 */
async function sendApplication(c: Context<Vars>, drawn: FormAgain): Promise<Response> {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const { company, role } = job;
  const posted = postedApplyForm(body, job.packet.formQuestions);
  const admitted = admits(container, job, posted.formOpened);
  if (!admitted.ok) return c.notFound();
  const form = applyFormFor(container, job, await applyFlowOf(container, job), posted.source);
  // A form shown again keeps the moment it was first opened, so the closing date's grace still applies to it.
  const formOpened = posted.formOpened || sealFormOpened(container.env.SESSION_SECRET, role.id, container.engine.clock());
  // The versions recorded as shown are the server's own, computed from the same inputs as the render; a browser cannot claim a different set.
  // The one exception is the line before Send on a job past its limit: a form opened before the limit was hit never showed
  // it, whatever the job says now, so only the page itself can say that it did (it adds to the record, and decides nothing).
  const noticeVersionsShown = [...noticeVersionsFor(form.notices), ...(bodyString(body)("onFileShown") === "yes" ? [ON_FILE_NOTICE] : [])];
  const { values, acknowledged } = posted;
  // A resume the browser already uploaded stays attached: its grant, still valid for this company and job, goes back into
  // the form. A file posted inside the form (or a grant that no longer opens) cannot be put back, and the page says so.
  const held = heldUpload(container, job, posted.grant);
  const keptResume = held ? { grant: posted.grant, filename: held.filename } : null;
  const resumeLost = !keptResume && (!!postedFile(body) || !!posted.grant);
  const again = (error: string, missing: string[] = [], status: 400 | 500 = 400) => c.html(<ApplyFormPage {...form} formOpened={formOpened} error={`${error} ${keptSentence(resumeLost)}`} state={{ values, answers: posted.shown, acknowledged, missing, resume: keptResume, resumeLost }} />, status);
  // From here whatever fails before the application is stored brings this form back, with what was typed (`formPost`).
  drawn.again = (error) => again(error, [], 500);
  // Honeypot: a filled hidden field gets the receipt a person gets, and nothing is recorded.
  if (posted.website) return toReceipt(c, job, values.email, form.flow === "on_file");
  const parsed = ApplyRequest.safeParse({ firstName: values.firstName, lastName: values.lastName, email: values.email, phone: values.phone || undefined, answers: posted.answers, noticeVersionsShown, acknowledged });
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
    const onlyAcknowledgment = missing.length === 1 && missing[0] === "acknowledged";
    return again(onlyAcknowledgment ? "One more step: please confirm you have read the notice at the bottom of the form." : applyFormProblem(missing), missing);
  }
  if (posted.problems.length) return again(`Please check your ${posted.problems.length === 1 ? "answer" : "answers"}: ${posted.problems.map((p) => `"${p.question}" needs ${p.problem}`).join("; ")}.`, posted.problems.map((p) => p.field));
  if (posted.unanswered.length) return again(`Please answer ${posted.unanswered.length === 1 ? "this question" : "these questions"}: ${posted.unanswered.map((q) => `"${q.question}"`).join("; ")}.`, posted.unanswered.map(fieldOf));

  let resume: ResumeUpload | null = null;
  let usedUploadId: string | null = null;
  if (posted.grant) {
    // The browser uploaded straight to storage; the grant names the object. It must be for this company and job.
    if (!held) return again(UPLOAD_EXPIRED, ["resume"]);
    // One submission per grant, refused before the file is looked at (services/applications.ts, uploadAlreadyUsed).
    if (await withTenant(container.db, company.id, (tx) => uploadAlreadyUsed(tx, { roleId: role.id, uploadId: held.uploadId }))) return again(UPLOAD_EXPIRED, ["resume"]);
    const head = await container.integrations.storage.head(held.key);
    if (!head || head.size === 0) return again("Your uploaded resume did not arrive. Please attach the file again.", ["resume"]);
    if (head.size > MAX_RESUME_BYTES) {
      await container.integrations.storage.delete(held.key);
      return again("Resume files must be under 8 MB.", ["resume"]);
    }
    resume = { kind: "stored", filename: held.filename, mime: held.mime, storageKey: held.key, sizeBytes: head.size, via: "direct" };
    usedUploadId = held.uploadId;
  } else {
    const f = postedFile(body);
    if (f) {
      // The form carried the file itself (no JavaScript, or the direct upload failed): the platform refuses large bodies before this code runs, so the friendly limit is lower.
      if (f.size > NO_SCRIPT_MAX_RESUME_BYTES) return again(f.size > MAX_RESUME_BYTES ? "Resume files must be under 8 MB." : "Files over 4 MB can only be sent by the direct upload, which needs JavaScript. Please choose a smaller file, or try again with JavaScript turned on.", ["resume"]);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const look = inspectResumeFile(bytes, { mime: f.type, filename: f.name });
      if (!look.ok) return again(look.reason === "unsupported_type" || look.reason === "type_mismatch" ? "Please upload a PDF, Word (.docx), or text file." : `That file cannot be used: ${look.detail}.`, ["resume"]);
      resume = { kind: "bytes", filename: f.name, mime: look.mime, bytes, via: "server" };
    }
  }
  if (!resume) return again("Please attach your resume to send your application.", ["resume"]);

  // The consent record carries the address the trusted proxy reports, never one the client wrote into the header.
  const ip = clientIp(c);
  const created = await withNewApplication(container, company.id, async (tx, files) => {
    if (usedUploadId) await markUploadUsed(tx, { companyId: company.id, roleId: role.id, uploadId: usedUploadId });
    return createApplication(tx, container, {
      companyId: company.id,
      roleId: role.id,
      source: posted.source ?? "careers_page",
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      consentSource: "careers_page_apply",
      noticeVersionsShown,
      acknowledgment: { at: container.engine.clock().toISOString(), noticeVersions: noticeVersionsShown, ...(ip ? { ip } : {}) },
      answers: parsed.data.answers,
      resume,
      ip,
    }, { kind: "candidate", id: "applicant" }, { closingGrace: admitted.late, trialGrace: admitted.trialGrace, files });
  });
  drawn.committed = true;
  await container.kick();
  return toReceipt(c, job, parsed.data.email, created.onFile);
}

candidatePages.post("/careers/:slug/jobs/:roleId/apply", rateLimit(POLICIES.apply), (c) => formPost(c, (drawn) => sendApplication(c, drawn)));

/** What each field the form checks needs, in the words the error line uses. */
const FIELD_PROBLEM: Record<string, string> = {
  firstName: "your first name",
  lastName: "your last name",
  email: "a valid email address",
  phone: "a phone number of at least 7 digits, or leave it empty",
  acknowledged: "the confirmation box at the bottom of the form",
};

/**
 * The error line over a form sent back: it names exactly the fields that are highlighted, so a short phone number is
 * never blamed on the name, the email or the confirmation box.
 */
export function applyFormProblem(missing: readonly string[]): string {
  const named = missing.map((m) => FIELD_PROBLEM[m]).filter((x): x is string => !!x);
  if (!named.length) return "Please check the highlighted fields and send the form again.";
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `Please check the highlighted ${named.length === 1 ? "field" : "fields"}: ${list}.`;
}

/**
 * The receipt, in plain words: it never names a status link. Worked out from what was typed, so a known address reads as
 * a new one. On a job past its limit (`onFile`; `onFileBy`, the day they hear by) it says only what is true of them: on
 * file, and when they hear. Those words are DRAFT WORDING PENDING COUNSEL (packages/core/src/candidate-lock.ts). With its
 * cookie gone there is no day to name, and nothing about who is asking: on such a job it promises no review.
 */
function Receipt(props: { company: { slug: string; name: string }; role: { id: string }; packet: RolePacket; to: string | null; onFile: boolean; onFileBy: string | null }) {
  return (
    <Layout title="We have your application">
      <p class="eyebrow"><a href={`/careers/${props.company.slug}/jobs/${props.role.id}`}>{props.packet.identity.title}</a></p>
      <h1>Thanks, we have your application</h1>
      <div class="card" role="status">
        <p><strong>Check your email.</strong> Your own link to this application goes to {props.to ?? "the email address you gave"}.</p>
        <p>Keep that email. The link is how you check where things stand, withdraw, or ask about your information. There is no account or password.</p>
      </div>
      <h2>What happens next</h2>
      <ol class="steps">
        {props.onFile ? (
          <>
            {props.onFileBy ? <li>{onFileReceiptLine(props.company.name, props.onFileBy)}</li> : null}
            <li>People make every decision.</li>
            {props.onFileBy ? null : <li>You hear from us by email either way.</li>}
          </>
        ) : (
          <>
            <li>The hiring team at {props.company.name} reviews your application.</li>
            <li>If you are shortlisted, we email you a link to a short AI interview: a written chat you do at a time that suits you.</li>
            <li>The team decides. People on the hiring team make every decision.</li>
          </>
        )}
      </ol>
      {/* The earlier-emails line is true for a first application and a repeat alike: a repeat's reminder goes at most once a day. */}
      <details class="more">
        <summary>No email?</summary>
        <p>It can take a few minutes. Look in your spam or promotions folder too. If you applied for this job before, look in our earlier emails too: we send the link again at most once a day.</p>
        <p>If it still has not arrived, we can send your link again.</p>
        <a class="btn secondary" href="/c/link-request">Send my link again</a>
      </details>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

candidatePages.get("/careers/:slug/jobs/:roleId/applied", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const sealed = openPayload<ReceiptPayload>(RECEIPT_PURPOSE, readAppCookie(c, RECEIPT_COOKIE, { path: receiptPath(job.company.slug, job.role.id) }), container.env.SESSION_SECRET, container.engine.clock().getTime());
  const mine = sealed?.v === 1 && sealed.roleId === job.role.id ? sealed : null;
  c.header("Cache-Control", "no-store");
  const onFileBy = mine && typeof mine.by === "string" ? closeOutDayWords(mine.by, job.company.timezone) : null;
  const onFile = mine ? !!onFileBy : (await applyFlowOf(container, job)) === "on_file";
  return c.html(<Receipt company={job.company} role={job.role} packet={job.packet} to={mine && typeof mine.to === "string" ? mine.to : null} onFile={onFile} onFileBy={onFileBy} />);
});
