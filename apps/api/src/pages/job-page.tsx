/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { DraftRolePacket } from "@ros/contracts";
import { candidateNotices, type Notice } from "@ros/core";
import type { ContactLine } from "../services/company-settings-profile";
import { applySteps, applyTimeLine, type ApplyFlowView } from "../services/job-preview";
import { Description } from "./description";
import { Icon } from "./icons";
import { JobFacts, publicPay } from "./job-facts";
import { Layout, currentNonce, type ShareTags } from "./layout";

/**
 * The job page and the apply form, shared by the public pages (pages/candidate.tsx) and the authenticated preview
 * (pages/preview.tsx, plan D1): one component each, taking the packet, the company and, for a preview, what to say
 * about it. A preview carries no structured data, no share tags, no form that sends anything and no link to a public
 * address that may not exist yet; it is marked "not public yet" and kept out of search results.
 */

/** What the pages say about the company: only text a person approved, the logo we store, and who answers before applying. */
export type JobPageCompany = { name: string; slug: string; about: string | null; website: string | null; logoSrc: string | null; contact: ContactLine };

export type JobPageRole = {
  id: string;
  accepting: boolean;
  /** What the page says instead of the Apply button. */
  closedMessage: string | null;
  /** The day the role opened (roles.openedAt); null before it is public. */
  postedOn: string | null;
  /** "Apply by Friday, October 30, 2026" when the role has a closing date (plan D7). */
  applyBy: string | null;
};

/** How a preview introduces itself, and where its own links go. */
export type PreviewInfo = { notPublicYet: boolean; banner: string; gaps: string[]; jobHref: string; applyHref: string; publicHref: string | null };

/** "Harbor Dental" → "HD": what the logo square shows when the company has not uploaded one. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** A company website as a link: a typed "acme.com" gets its https://, and the words drop the scheme. */
function website(value: string): { href: string; text: string } {
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return { href, text: value.replace(/^https?:\/\//i, "").replace(/\/$/, "") };
}

/** The logo square (or the initials) beside the company's name; decorative, since the name is always written beside it. */
export function CompanyLine(props: { company: Pick<JobPageCompany, "name" | "logoSrc">; eyebrow: unknown }) {
  return (
    <div class="company">
      <span class="logo" aria-hidden="true">{props.company.logoSrc ? <img src={props.company.logoSrc} alt="" width="56" height="56" /> : initials(props.company.name)}</span>
      <div>
        <p class="eyebrow">{props.eyebrow}</p>
      </div>
    </div>
  );
}

/** The address a candidate writes to before applying, with the person's name when the company gave one. */
function ContactLink(props: { contact: ContactLine }) {
  return <>{props.contact.name ? `${props.contact.name} at ` : ""}<a href={`mailto:${props.contact.email}`}>{props.contact.email}</a></>;
}

/** The pre-apply line (plan D10): help applying, or a change to how to apply because of a disability, from a person. */
export function HelpLine(props: { contact: ContactLine; class?: string }) {
  return <p class={props.class ?? "help-line"}>Need help applying, or a change to how you apply because of a disability? Email <ContactLink contact={props.contact} /> and a person will help.</p>;
}

/**
 * Four things that are true of every application here: how long (the conversation included, when it follows the form;
 * plan E8), what to send, who decides, how to reach a person.
 */
export function FourPoints(props: { company: Pick<JobPageCompany, "name" | "contact">; packet: Pick<DraftRolePacket, "screening">; flow: ApplyFlowView }) {
  return (
    <ul class="points">
      <li><Icon name="clock" /><span>{applyTimeLine(props.packet, { companyName: props.company.name, flow: props.flow })}</span></li>
      <li><Icon name="paperclip" /><span>A resume, or a few lines about your work. No cover letter.</span></li>
      <li><Icon name="people" /><span>People at {props.company.name} make every hiring decision.</span></li>
      <li><Icon name="mail" /><span>Questions? Email <ContactLink contact={props.company.contact} /> to reach a person.</span></li>
    </ul>
  );
}

/** The "not public yet" note at the top of a preview, with what the page is still missing. */
export function PreviewNote(props: { preview: PreviewInfo }) {
  const p = props.preview;
  return (
    <div class="preview-note" role="note">
      <p><strong>{p.notPublicYet ? "Not public yet." : "Preview."}</strong> {p.banner} Links on this preview stay on it, and its form sends nothing.</p>
      {p.gaps.length ? <ul>{p.gaps.map((g) => <li>{g}</li>)}</ul> : null}
      {p.publicHref ? <p><a href={p.publicHref}>Open the public page</a></p> : null}
    </div>
  );
}

export type JobPageProps = {
  packet: DraftRolePacket;
  company: JobPageCompany;
  role: JobPageRole;
  /** Every notice for the job's places; the page decides which it renders. */
  notices: Notice[];
  smsEnabled: boolean;
  /** How applicants meet the screening conversation (services/job-preview.ts `applyFlowOf`): what the time and the steps say. */
  flow: ApplyFlowView;
  /** The benefits the law (or the company) has the page describe: the role's own, else the company's (Setup). */
  benefits: string | null;
  links: { careers: string | null; apply: string };
  preview?: PreviewInfo;
  jsonLd?: Record<string, unknown>;
  share?: ShareTags;
  description?: string;
};

/**
 * The job page (plan D10): the company with its logo, the title, every fact as a pill and a first Apply button; then the
 * description in headed sections, what the team is looking for, what would be nice, the benefits, the steps and the
 * notices, and what the company says about itself; beside it, an apply card that stays in view with four true points
 * and how to reach a person. On a phone the card becomes a bar held at the bottom of the screen (CSS only) and the
 * points move into the page.
 */
export function JobPage(props: JobPageProps) {
  const { packet, company, role, preview } = props;
  const title = packet.identity.title;
  const pay = publicPay(packet, props.notices);
  const notices = candidateNotices(props.notices).filter((n) => n.key === "ai_use" || n.key === "pay_transparency");
  const mustHaves = packet.requirements.mustHaves.map((m) => m.text.trim()).filter(Boolean);
  const niceToHaves = packet.requirements.niceToHaves.map((m) => m.text.trim()).filter(Boolean);
  const careers = props.links.careers;
  return (
    <Layout title={preview ? `Preview: ${title} at ${company.name}` : `${title} at ${company.name}`} jsonLd={preview ? undefined : props.jsonLd} wide description={preview ? undefined : props.description} share={preview ? undefined : props.share} noindex={!!preview}>
      {preview ? <PreviewNote preview={preview} /> : null}
      <div class="job-head">
        <CompanyLine company={company} eyebrow={careers ? <a href={careers}>Careers at {company.name}</a> : `Careers at ${company.name}`} />
        <h1>{title}</h1>
        <JobFacts packet={packet} pay={pay} postedOn={role.postedOn} />
        {role.accepting ? (
          <div class="head-actions">
            <a class="btn head-apply" href={props.links.apply}>Apply now</a>
            {role.applyBy ? <p class="apply-by"><Icon name="calendar" />{role.applyBy}</p> : null}
          </div>
        ) : null}
      </div>
      {!role.accepting ? <div class="alert caution" role="status">{role.closedMessage}</div> : null}
      {/* The description, the steps and the notices come first in reading order; the apply panel follows them (beside them on a wide screen, held at the bottom of a phone's screen). */}
      <div class={role.accepting ? "job-layout" : "job-layout solo"}>
        <div class="job-main">
          {role.accepting ? (
            <div class="card points-card">
              <FourPoints company={company} packet={packet} flow={props.flow} />
              <HelpLine contact={company.contact} />
            </div>
          ) : null}
          <div class="card job-body">
            <h2>About the job</h2>
            <Description text={packet.description.publicJobDescription} />
            {mustHaves.length ? <h2>What we're looking for</h2> : null}
            {mustHaves.length ? <ul class="checks">{mustHaves.map((t) => <li><Icon name="check" /><span>{t}</span></li>)}</ul> : null}
            {niceToHaves.length ? <h2>Nice to have</h2> : null}
            {niceToHaves.length ? <ul class="checks">{niceToHaves.map((t) => <li><Icon name="check" /><span>{t}</span></li>)}</ul> : null}
            {props.benefits ? <h2>Benefits</h2> : null}
            {props.benefits ? <p class="pre">{props.benefits}</p> : null}
            <h2>What to expect</h2>
            <ol class="steps">
              {applySteps(packet, { companyName: company.name, smsEnabled: props.smsEnabled, flow: props.flow }).map((s) => <li>{s}</li>)}
            </ol>
            {notices.map((n) => <p class="notice">{n.text}</p>)}
          </div>
          {company.about ? (
            <section class="card about" aria-labelledby="about-company">
              <h2 id="about-company">About {company.name}</h2>
              <p class="pre">{company.about}</p>
              {company.website ? <a class="site" href={website(company.website).href} rel="noopener">{website(company.website).text}<Icon name="external" /></a> : null}
            </section>
          ) : null}
        </div>
        {role.accepting ? (
          <div class="apply-panel">
            <div class="card apply-card">
              <p class="apply-title">{title}</p>
              {role.applyBy ? <p class="apply-by"><Icon name="calendar" />{role.applyBy}</p> : <p class="meta">We confirm by email.</p>}
              <a class="btn" href={props.links.apply}>Apply now</a>
              <FourPoints company={company} packet={packet} flow={props.flow} />
              <HelpLine contact={company.contact} />
            </div>
          </div>
        ) : null}
      </div>
      <p class="foot">{preview ? "On the public page: a link to get an application link again, and how we handle information." : <><a href="/c/link-request">Already applied? Get your application link again</a> · <a href="/privacy">How we handle your information</a></>}</p>
    </Layout>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The apply form                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * Applying without a resume (plan D10): four short questions instead of one empty box. The answers are kept as they
 * were typed and also written into one `summary`, the key every reader of an application already uses (the triage, the
 * candidate panel, applications that arrive by email), so nothing downstream has to change.
 */
export const NO_RESUME_QUESTIONS = [
  { key: "recentWork", label: "Your most recent job or work", hint: "The job title, where it was, and about how long. Unpaid, volunteer and caring work count too.", summary: "Most recent work" },
  { key: "dayToDay", label: "What you did day to day", hint: "A few lines is plenty.", summary: "Day to day" },
  { key: "skills", label: "Skills, licenses or tools that fit this job", hint: "For example a license, a certificate, or software you use.", summary: "Skills, licenses or tools" },
  { key: "lookingFor", label: "What you are looking for in your next job", hint: "The hours, the kind of work, or anything else that matters to you.", summary: "Looking for" },
] as const;
export type NoResumeKey = (typeof NO_RESUME_QUESTIONS)[number]["key"];
export const NO_RESUME_ANSWER_MAX = 1000;
const NO_RESUME_SUMMARY_MAX = 4000;

/** The guided answers (and the one box of an older form) as stored: each answer, plus the summary everyone reads. */
export function noResumeAnswersFrom(values: Partial<Record<NoResumeKey | "noResume", string>>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const lines: string[] = [];
  for (const q of NO_RESUME_QUESTIONS) {
    const v = (values[q.key] ?? "").trim().slice(0, NO_RESUME_ANSWER_MAX);
    if (!v) continue;
    out[q.key] = v;
    lines.push(`${q.summary}: ${v}`);
  }
  // A form opened before the questions existed sends one box, "noResume"; its words are the summary, as before.
  const legacy = (values.noResume ?? "").trim();
  if (legacy) lines.push(lines.length ? `In their words: ${legacy}` : legacy);
  if (!lines.length) return undefined;
  return { ...out, summary: lines.join("\n").slice(0, NO_RESUME_SUMMARY_MAX) };
}

/**
 * What a re-rendered form keeps (D12): every typed value, every eligibility answer, both checkboxes, which fields were
 * missing, and a resume the browser already uploaded directly (its sealed grant goes back into the form, so the file
 * stays attached). A file posted inside the form itself cannot be put back by any browser: `resumeLost` makes the page
 * say so instead of claiming everything is still there.
 */
export type ApplyFormState = { values: Record<string, string>; answers: Record<string, string | string[]>; acknowledged: boolean; smsConsent: boolean; missing: string[]; resume: { grant: string; filename: string } | null; resumeLost: boolean };

/** The sentence a re-shown form ends its error with: true about what is still on the page. */
export function keptSentence(resumeLost: boolean): string {
  return resumeLost ? "Everything you typed is still here, but please attach your resume again." : "Everything you entered is still here.";
}

/**
 * The notice versions recorded as shown (docs/readiness/20 section D): the notices the page renders as text, plus the
 * SMS consent text only when the checkbox was on the page. Computed by the server on every render and again on the
 * submission, never taken from the browser.
 */
export function noticeVersionsFor(notices: Notice[], smsEnabled: boolean): string[] {
  const shown = candidateNotices(notices);
  const sms = smsEnabled ? notices.find((n) => n.key === "sms_consent") : undefined;
  return [...shown, ...(sms ? [sms] : [])].map((n) => `${n.key}@${n.version}`);
}

export type ApplyFormProps = {
  company: { slug: string; name: string; contact: ContactLine };
  role: { id: string };
  packet: DraftRolePacket;
  /** Every notice for the jurisdictions; the form itself decides what is rendered (candidateNotices) and what is a checkbox. */
  notices: Notice[];
  smsEnabled: boolean;
  privacyEmail: string;
  /** The sealed "form opened at" value (services/closing-date.ts): a form opened before the closing date may still be sent. */
  formOpened: string;
  /** How applicants meet the screening conversation: the lead says how long applying takes (plan E8). */
  flow: ApplyFlowView;
  links: { job: string; uploadIntent: string };
  error?: string;
  state?: Partial<ApplyFormState>;
  preview?: PreviewInfo;
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
      <p><strong>{props.company.name}</strong> runs this hiring process and is the employer. People at {props.company.name} make every hiring decision. Software helps organize and summarize applications, and works out a match score from what you send, checked against the job's requirements; the team sees what the score is based on, and a person always decides.</p>
      <p><strong>What we collect:</strong> your name, your email, your phone number if you give one, where you are based, your resume or your answers about your work, and your answers to the questions above.</p>
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

/** The fields themselves, shared by the real form and the preview's form that sends nothing. */
function ApplyFields(props: ApplyFormProps) {
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
  // The words of an older one-box form go back into the first question, so nothing typed is lost.
  const guided = (key: NoResumeKey) => v[`nr_${key}`] || (key === "recentWork" ? v.noResume ?? "" : "");
  const noResumeOpen = missing.has("noResume") || NO_RESUME_QUESTIONS.some((q) => !!guided(q.key));
  return (
    <>
      <label for="firstName">First name</label>
      <input id="firstName" type="text" name="firstName" required autocomplete="given-name" value={v.firstName ?? ""} aria-invalid={invalid("firstName")} />
      <label for="lastName">Last name</label>
      <input id="lastName" type="text" name="lastName" required autocomplete="family-name" value={v.lastName ?? ""} aria-invalid={invalid("lastName")} />
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email" value={v.email ?? ""} aria-invalid={invalid("email")} />
      <label for="phone">Mobile phone (optional)</label>
      <input id="phone" type="tel" name="phone" autocomplete="tel" value={v.phone ?? ""} aria-invalid={invalid("phone")} />
      {smsNotice ? <label class="check"><input type="checkbox" name="smsConsent" value="yes" checked={!!props.state?.smsConsent} /> <span>{smsNotice.text}</span></label> : null}
      <label for="locationText">Where are you based? (city, state)</label>
      <input id="locationText" type="text" name="locationText" value={v.locationText ?? ""} aria-invalid={invalid("locationText")} />
      <label for="resume">Resume (PDF, Word, or text; up to 8 MB, or up to 4 MB without JavaScript)</label>
      <input id="resume" type="file" name="resume" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" />
      <small id="upload-note" aria-live="polite">{kept ? `Your resume ${kept.filename} is still attached. Choose a file only if you want to replace it.` : props.state?.resumeLost ? "Your resume is not attached any more. Please choose the file again." : ""}</small>
      <details class="no-resume" open={noResumeOpen}>
        <summary>No resume? Answer four short questions instead</summary>
        <p class="meta" id="no-resume-note">Answer what you can; one answer is enough to apply. Nobody expects a cover letter.</p>
        {NO_RESUME_QUESTIONS.map((q) => (
          <>
            <label for={`nr_${q.key}`}>{q.label}</label>
            <textarea id={`nr_${q.key}`} name={`nr_${q.key}`} rows={3} maxlength={NO_RESUME_ANSWER_MAX} aria-describedby={`nr_${q.key}-hint`} aria-invalid={q.key === "recentWork" ? invalid("noResume") : undefined}>{guided(q.key)}</textarea>
            <small id={`nr_${q.key}-hint`}>{q.hint}</small>
          </>
        ))}
      </details>
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
    </>
  );
}

/** The apply form: the job's facts on top, the pre-apply help line, the fields, and (outside a preview) the upload script. */
export function ApplyFormPage(props: ApplyFormProps) {
  const { preview } = props;
  return (
    <Layout title={`${preview ? "Preview: apply" : "Apply"}: ${props.packet.identity.title} at ${props.company.name}`} noindex={!!preview}>
      {preview ? <PreviewNote preview={preview} /> : null}
      <p class="back"><a href={props.links.job}><Icon name="arrow-left" />Back to the job</a></p>
      {/* The facts of the job stay in view while applying (Wave 0 item 0.8), pay included wherever the page must show it. */}
      <p class="eyebrow">{props.company.name}</p>
      <h1>Apply: {props.packet.identity.title}</h1>
      <JobFacts packet={props.packet} pay={publicPay(props.packet, props.notices)} />
      <p class="lead">{props.flow === "one_visit" ? `${applyTimeLine(props.packet, { companyName: props.company.name, flow: props.flow })} First this form: upload a resume, or answer four short questions about your work instead. No cover letter needed.` : `${applyTimeLine(props.packet, { companyName: props.company.name, flow: props.flow })} Upload a resume, or answer four short questions about your work instead. No cover letter needed.`}</p>
      <HelpLine contact={props.company.contact} class="notice" />
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      {preview ? (
        <div class="form-preview">
          <fieldset disabled>
            <legend class="sr-only">The form as candidates see it; it sends nothing here</legend>
            <ApplyFields {...props} />
            <button class="btn" type="button" disabled>Send my application</button>
            {props.flow === "one_visit" ? <p class="meta">Next comes the short written conversation with {props.company.name}'s AI assistant. You can start it straight away, do it later, or ask for a person instead.</p> : null}
          </fieldset>
        </div>
      ) : (
        <form method="post" enctype="multipart/form-data" data-upload-intent={props.links.uploadIntent}>
          <input type="text" name="website" tabindex={-1} autocomplete="off" style="position:absolute;left:-10000px" aria-label="Leave this field empty" />
          <input type="hidden" name="uploadGrant" value={props.state?.resume?.grant ?? ""} />
          <input type="hidden" name="formOpened" value={props.formOpened} />
          <ApplyFields {...props} />
          <input type="hidden" name="noticeVersionsShown" value={noticeVersionsFor(props.notices, props.smsEnabled).join(",")} />
          <button class="btn" type="submit">Send my application</button>
          {props.flow === "one_visit" ? <p class="meta">Next comes the short written conversation with {props.company.name}'s AI assistant. You can start it straight away, do it later, or ask for a person instead.</p> : null}
        </form>
      )}
      {preview ? null : <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_UPLOAD_JS }} />}
    </Layout>
  );
}

/**
 * Direct-to-storage upload (founder decision 2): with script, the résumé goes from the browser straight to storage
 * under a short-lived, single-object authorization and the form carries only a sealed grant; without script, or if
 * the upload fails, the form posts the file itself as before. Plain ES5, no inline handlers (the policy forbids them),
 * no third-party code, nothing about the person leaves the page except the file's name, size and type (and the form's
 * own sealed "opened at" value, so a form opened before a closing date can still upload).
 */
export const APPLY_UPLOAD_JS = `(function(){
var form=document.querySelector('form[data-upload-intent]');if(!form||!window.fetch||!window.FormData){return;}
var input=form.querySelector('input[type=file][name=resume]');var grant=form.querySelector('input[name=uploadGrant]');var opened=form.querySelector('input[name=formOpened]');var note=document.getElementById('upload-note');var submit=form.querySelector('button[type=submit]');
if(!input||!grant){return;}
var busy=false;
function say(t){if(note){note.textContent=t;}}
input.addEventListener('change',function(){if(input.files&&input.files.length&&grant.value){grant.value='';say('');}});
function fallback(file){form.removeAttribute('data-upload-intent');if(file.size>4*1024*1024){say('The direct upload did not work. Files over 4 MB can only be sent by the direct upload: please try again in a moment, or choose a smaller file.');busy=false;if(submit){submit.disabled=false;}return;}form.submit();}
form.addEventListener('submit',function(ev){
if(busy){ev.preventDefault();return;}
var file=input.files&&input.files[0];if(!file||grant.value){return;}
ev.preventDefault();busy=true;if(submit){submit.disabled=true;}say('Uploading your resume…');
fetch(form.getAttribute('data-upload-intent'),{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({filename:file.name,size:file.size,type:file.type,formOpened:opened?opened.value:''})})
.then(function(r){return r.json().then(function(j){if(!r.ok){throw new Error((j&&j.error&&j.error.message)||'The upload was refused.');}return j;});})
.then(function(j){return fetch(j.url,{method:j.method,headers:j.headers,body:file}).then(function(r){if(!r.ok){throw new Error('The upload did not complete.');}grant.value=j.grant;});})
.then(function(){input.value='';say('Resume uploaded.');busy=false;if(submit){submit.disabled=false;}form.submit();})
.catch(function(e){say((e&&e.message)||'The upload did not work.');fallback(file);});
});
})();`;
