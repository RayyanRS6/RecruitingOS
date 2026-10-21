/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { randomInt } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ApplyRequest, MAX_RESUME_BYTES, inspectResumeFile, trialStanding, type CompanyQuestions, type DraftRolePacket, type LearnedFact, type QuickQuestionView, type RolePacket } from "@ros/contracts";
import { answerCvLines, chatFactsWithKept } from "@ros/agents";
import { applicationAnswerSentences, candidateNotices, emit, openPayload, quickQuestionsOf, sealPayload, type Notice } from "@ros/core";
import { randomToken, uuidv7, withTenant } from "@ros/db";
import { refFor } from "@ros/integrations";
import { UPLOAD_GRANT_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS, checkUploadIntent, quarantineKey, type UploadGrantPayload } from "../uploads";
import { clientIp, type Vars } from "../middleware/session";
import type { Container } from "../container";
import { POLICIES, checkRateLimits, rateLimit, type Policy } from "../middleware/rate-limit";
import { createApplication, markUploadUsed, uploadAlreadyUsed, type ResumeInput as ResumeUpload } from "../services/applications";
import { READ_GRANT_TTL_SECONDS, READ_WAIT_MS, readingAskedAt, readingFor, readingGaveUp, startResumeReading, suggestQuickAnswer, waitForReading, type ResumeReading } from "../services/apply-details";
import { applyVisitNext, interviewWaitFor, type InterviewWait } from "../services/apply-conversation";
import { formOpenedBefore, lateApplicationAllowed, sealFormOpened } from "../services/closing-date";
import { contactLineFor, type ContactLine } from "../services/company-settings-profile";
import { APPLY_FLOW, applyTimeLine, type ApplyFlowView } from "../services/job-preview";
import { factsToKeep, keepFactsOn, keptFactsOf, reusedDetailsFor, type ReusedDetails } from "../services/profile-facts";
import { CONVERSATION_COOKIE, CONVERSATION_PURPOSE, acceptingApplications, jobNotices, jobTakesApplications, loadJob, maskEmail, screenPath, type ConversationPayload, type Job } from "./candidate-shared";
import { Icon } from "./icons";
import { JobFacts, publicPay } from "./job-facts";
import { ContactLink, HelpLine, PreviewNote, type PreviewInfo } from "./job-page";
import { JOURNEY_CSS, Journey } from "./journey";
import { Layout, currentNonce } from "./layout";
import { clearApplicationSource, resolveApplicationSource } from "./links";
import { fromChatLine } from "./profile-pages";
import { quickQuestionHelp, withPlainQuestionHelp } from "./question-help";

/**
 * Applying (Wave S7, S7-0: moved as it was from pages/job-page.tsx and pages/candidate.tsx): the apply form, shared by
 * the public page and the authenticated preview (pages/preview.tsx); the routes that show it, take a direct upload and
 * take the application; and the receipt. Mounted on the candidate pages by pages/candidate.tsx.
 *
 * Wave S7, slice S7-B (the Kanvis-style start, spec steps 2 to 5): the form starts with the résumé. "Read my resume"
 * hands it to software that fills in the details (services/apply-details.ts: the worker checks and scans the file, then
 * `resume.extract` on Haiku 5.5 reads it), and the same form comes back as "Check your details", every filled field
 * marked "From your resume — check it". The company's own quick questions follow as "Questions from <Company>",
 * numbered, with a count of what is answered and an answer suggested from the résumé where it says so plainly. The steps
 * header (Details · Chat · Review & send) sits on top when the chat follows in the same visit. Everything works without
 * script: reading is a button that posts the form, and the page that waits for a slow reading has a Continue button.
 * The form still takes everything as one page, exactly as before (a person may fill it in without reading anything).
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as applyPages };

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
/** The longest summary of their work the form keeps (the résumé reading writes a few lines; the candidate may change them). */
export const WORK_SUMMARY_MAX = 1500;

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

/** The marks a filled value carries, said beside it so the candidate checks it (spec steps 3 and 4). */
export const FROM_RESUME_TAG = "From your resume — check it";
/** The résumé card's own notice, before the file is chosen (with script, choosing it starts the reading). */
export const RESUME_READ_NOTICE = "An AI service reads the resume you choose here, to fill in this form for you.";
export const SUGGESTED_FROM_RESUME_TAG = "Suggested from your resume — check it";
export const FROM_EARLIER_TAG = "From your earlier application — check it";

/** The details a résumé reading (or an earlier application) may fill in, in the form's own field names. */
export const DETAIL_FIELDS = ["firstName", "lastName", "email", "phone", "locationText", "workSummary"] as const;

/**
 * Which values the page marks: `fromResume`, the details the résumé filled in and the candidate has not changed;
 * `suggested`, the quick questions' fields (`elig_<key>`, `q_<key>`) answered from the résumé; `reused`, the details
 * from their earlier application to this company (S7-F's emailed link).
 */
export type ApplyFormMarks = { fromResume: string[]; suggested: string[]; reused: string[] };

/** What the page says about the résumé it read: `skipped` when the candidate chose to fill the form in themselves. */
export type ApplyFormReading = { filename: string; outcome: Exclude<ResumeReading["outcome"], "refused"> | "skipped" };

/**
 * Wave S8: "From your earlier chats at <Company>", on a form opened from the emailed reuse link only. `token`: that sealed
 * link, carried in the form so Send opens it again; `facts`: what the candidate's sent chats here taught their record,
 * read through the link; `kept`: the ids still ticked (all of them when the form opens); `timeZone`: the company's, for
 * the dates.
 */
export type EarlierFactsState = { token: string; facts: LearnedFact[]; kept: string[]; timeZone: string };

/**
 * What a re-rendered form keeps (D12): every typed value, every answer (the eligibility questions' and the company's
 * quick questions', by question key), both checkboxes, which fields were missing, and a resume the browser already
 * uploaded directly (its sealed grant goes back into the form, so the file stays attached). A file posted inside the
 * form itself cannot be put back by any browser: `resumeLost` makes the page say so instead of claiming everything is
 * still there. Wave S7 adds the marks and the résumé reading the page shows ("Check your details"); Wave S8 the facts
 * from earlier chats a form opened from the reuse link lists, ticked as they were.
 */
export type ApplyFormState = { values: Record<string, string>; answers: Record<string, string | string[]>; acknowledged: boolean; smsConsent: boolean; missing: string[]; resume: { grant: string; filename: string } | null; resumeLost: boolean; marks?: Partial<ApplyFormMarks>; reading?: ApplyFormReading | null; earlier?: EarlierFactsState | null };

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

/** The packet as the form reads it: a saved version carries the company's own questions; a draft has none yet. */
export type ApplyFormPacket = DraftRolePacket & { companyQuestions?: CompanyQuestions | null };

export type ApplyFormProps = {
  company: { slug: string; name: string; contact: ContactLine };
  role: { id: string };
  packet: ApplyFormPacket;
  /** Every notice for the jurisdictions; the form itself decides what is rendered (candidateNotices) and what is a checkbox. */
  notices: Notice[];
  smsEnabled: boolean;
  privacyEmail: string;
  /** The sealed "form opened at" value (services/closing-date.ts): a form opened before the closing date may still be sent. */
  formOpened: string;
  /** How applicants meet the AI interview: the lead says how long applying takes (plan E8). */
  flow: ApplyFlowView;
  /**
   * `apply` where the form sends the application (its own address: a form shown after a reading is at another one);
   * `read` where "Read my resume" posts it; `reuse` where "Applied here before?" asks for the emailed link (S7-F). A
   * preview has none of these: its form sends nothing.
   */
  links: { job: string; uploadIntent: string; apply?: string; read?: string; reuse?: string };
  error?: string;
  state?: Partial<ApplyFormState>;
  preview?: PreviewInfo;
};

/** "Questions from <Company>": the eligibility questions and the company's quick questions, each with its plain line. */
export function formQuestions(packet: ApplyFormPacket): QuickQuestionView[] {
  return quickQuestionsOf(packet).map((q) => (q.source === "company" ? { ...q, help: quickQuestionHelp(q.help) } : q));
}

/**
 * The transparency block (docs/readiness/20 section D, items 1 to 10) sits above the submit button: who runs the
 * process, what is collected and why, who may see it, how to exercise the candidate's rights, the privacy address, the
 * link to the notice, and the affirmative acknowledgment. Plain words, short sentences, nothing pre-checked.
 *
 * First view (founder brief, 14 October 2026): three short lines and the privacy link; the full notice, every word of it
 * as before (its own privacy link and the notices included), sits under "Read the full notice", above the box that says
 * the full notice was read (its words name the fold). A form sent back without that box ticked opens the notice.
 */
function TransparencyBlock(props: { company: { name: string }; notices: Notice[]; privacyEmail: string; acknowledged: boolean; missing: boolean; resumeLost: boolean }) {
  return (
    <section class="card" aria-labelledby="before-you-send">
      <h2 id="before-you-send">Before you send</h2>
      <ul class="steps">
        <li>People at {props.company.name} make every hiring decision.</li>
        <li>Software helps organize applications and works out a match score.</li>
        <li>You can ask for a person at any time.</li>
      </ul>
      <p><a href="/privacy">Read how we handle your information</a></p>
      <details class="more" open={props.missing || undefined}>
        <summary>Read the full notice</summary>
        <p><strong>{props.company.name}</strong> runs this hiring process and is the employer. People at {props.company.name} make every hiring decision. Software helps organize and summarize applications, and works out a match score from what you send, checked against the job's requirements; the team sees what the score is based on, and a person always decides.</p>
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

/** A value's mark, between its label and its field, named by the field's description. */
function Tag(props: { id: string; text: string | null }) {
  return props.text ? <p class="tag" id={props.id}>{props.text}</p> : null;
}

const hasAnswer = (a: string | string[] | undefined) => (Array.isArray(a) ? a.length > 0 : !!a && a.trim() !== "");

/** The résumé's own field, with the line that says what happened to a file already sent (D12, D14). */
function ResumeInput(props: { kept: { filename: string } | null; resumeLost: boolean }) {
  return (
    <>
      <label for="resume">Resume (PDF, Word, or text; up to 8 MB, or up to 4 MB without JavaScript)</label>
      <input id="resume" type="file" name="resume" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" />
      <small id="upload-note" aria-live="polite">{props.kept ? `Your resume ${props.kept.filename} is still attached. Choose a file only if you want to replace it.` : props.resumeLost ? "Your resume is not attached any more. Please choose the file again." : ""}</small>
    </>
  );
}

/** "Read my resume": a button of the same form, posting it to the reading; in a preview, a button that does nothing. */
function ReadButton(props: { read?: string; preview: boolean; again?: boolean }) {
  const words = props.again ? "Read this resume instead" : "Read my resume";
  if (props.preview || !props.read) return <button class="btn secondary" type="button" disabled>{words}</button>;
  return <button class="btn secondary" type="submit" formaction={props.read} formnovalidate data-read="yes">{words}</button>;
}

/** Applying without a resume: the four short questions behind a disclosure that works without script. */
function NoResumeFold(props: { guided: (key: NoResumeKey) => string; open: boolean; invalid: boolean }) {
  return (
    // Each of the four boxes is named by its own question and described by its hint, and the four are one named group,
    // so a screen reader and voice control find every box by its words (polish list).
    <details class="no-resume" open={props.open}>
      <summary>No resume? Answer four short questions instead</summary>
      <fieldset aria-describedby="no-resume-note">
        <legend class="sr-only">Four short questions about your work, instead of a resume</legend>
        <p class="meta" id="no-resume-note">Answer what you can; one answer is enough to apply. Nobody expects a cover letter.</p>
        {NO_RESUME_QUESTIONS.map((q) => (
          <div>
            <label id={`nr_${q.key}-label`} for={`nr_${q.key}`}>{q.label}</label>
            <textarea id={`nr_${q.key}`} name={`nr_${q.key}`} rows={3} maxlength={NO_RESUME_ANSWER_MAX} aria-labelledby={`nr_${q.key}-label`} aria-describedby={`nr_${q.key}-hint`} aria-invalid={q.key === "recentWork" && props.invalid ? "true" : undefined}>{props.guided(q.key)}</textarea>
            <small id={`nr_${q.key}-hint`}>{q.hint}</small>
          </div>
        ))}
      </fieldset>
    </details>
  );
}

/** What the page says about a résumé it read (or tried to), in the place the résumé field had. */
function readLine(reading: ApplyFormReading): string {
  const f = reading.filename;
  switch (reading.outcome) {
    case "read":
      return `We read ${f} and filled in your details below. It stays attached to your application.`;
    case "unreadable":
      return `We could not read the words in ${f} (it may be a scanned page), so please fill in your details yourself. It stays attached to your application.`;
    case "failed":
      return `We could not read ${f} just now, so please fill in your details yourself. It stays attached to your application.`;
    default:
      return `${f} is attached to your application. Fill in your details below.`;
  }
}

/** One of "Questions from <Company>": two big Yes/No buttons, the days, the company's choices, or a number. */
function QuickQuestionItem(props: { q: QuickQuestionView; n: number; answer: string | string[] | undefined; invalid: boolean; suggested: boolean }) {
  const { q } = props;
  const helpId = `${q.field}-why`;
  const tagId = `${q.field}-tag`;
  const describedBy = [q.help ? helpId : "", props.suggested ? tagId : ""].filter(Boolean).join(" ") || undefined;
  const num = <span class="q-num" aria-hidden="true">{String(props.n).padStart(2, "0")}</span>;
  const mark = q.required ? <span class="req"> (required)</span> : null;
  const help = q.help ? <small id={helpId}>{q.help}</small> : null;
  const tag = <Tag id={tagId} text={props.suggested ? SUGGESTED_FROM_RESUME_TAG : null} />;
  if (q.kind === "number") {
    return (
      <li data-field={q.field}>
        <label class="question-label" for={q.field}>{num}{q.question}{mark}</label>
        {help}
        {tag}
        <div class="number-row">
          <input id={q.field} type="number" name={q.field} inputmode="decimal" step="any" min={q.min ?? undefined} max={q.max ?? undefined} required={q.required || undefined} value={typeof props.answer === "string" ? props.answer : ""} aria-invalid={props.invalid ? "true" : undefined} aria-describedby={describedBy} />
          {q.unit ? <span>{q.unit}</span> : null}
        </div>
      </li>
    );
  }
  const chosen = (value: string) => (Array.isArray(props.answer) ? props.answer.includes(value) : props.answer === value);
  // yes/no answers keep the values the server has always read ("yes", "no"); days and choices are sent as written
  const options = q.kind === "yes_no" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : q.options.map((o) => ({ value: o, label: o }));
  const multiple = q.kind === "days";
  return (
    <li data-field={q.field}>
      <fieldset aria-describedby={describedBy}>
        <legend class="question-legend">{num}{q.question}{mark}</legend>
        {help}
        {tag}
        <div class={q.kind === "yes_no" ? "choices pair" : multiple ? "choices days" : "choices"}>
          {options.map((o) => (
            <label class="check slot">
              <input type={multiple ? "checkbox" : "radio"} name={q.field} value={o.value} required={(!multiple && q.required) || undefined} checked={chosen(o.value) || undefined} aria-invalid={props.invalid ? "true" : undefined} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </li>
  );
}

/** "Questions from <Company>": numbered, the required ones marked, with a count of what is answered. */
function QuickQuestions(props: { company: string; questions: QuickQuestionView[]; answers: Record<string, string | string[]>; missing: Set<string>; suggested: Set<string> }) {
  const { questions } = props;
  if (!questions.length) return null;
  const answered = questions.filter((q) => hasAnswer(props.answers[q.key])).length;
  const required = questions.filter((q) => q.required).length;
  const suffix = required && required < questions.length ? ` · ${required} required` : "";
  return (
    <section class="quick" aria-labelledby="questions-title">
      <h2 id="questions-title">Questions from {props.company}</h2>
      <p class="q-count" id="q-count" aria-live="polite" data-suffix={suffix}>{`${answered} of ${questions.length} answered${suffix}`}</p>
      <ol class="questions">
        {questions.map((q, i) => <QuickQuestionItem q={q} n={i + 1} answer={props.answers[q.key]} invalid={props.missing.has(q.field)} suggested={props.suggested.has(q.field)} />)}
      </ol>
    </section>
  );
}

/**
 * "From your earlier chats at <Company>" (Wave S8): each fact the candidate's sent chats here taught their record, its
 * words and where it came from, with a box ticked to start with. What is still ticked at Send goes with this
 * application; only the facts' ids are sent back, with the sealed link so Send can read them again. Plain boxes inside
 * the form: it works without script.
 */
function EarlierFacts(props: { company: string; earlier: EarlierFactsState }) {
  const { earlier } = props;
  const kept = new Set(earlier.kept);
  return (
    <div class="card earlier">
      <fieldset aria-describedby="earlier-note">
        <legend>From your earlier chats at {props.company}</legend>
        <p class="meta" id="earlier-note">Untick anything that is no longer true. {props.company} sees what you keep as part of this application.</p>
        <input type="hidden" name="reuse" value={earlier.token} />
        <ul>
          {earlier.facts.map((f) => (
            <li>
              <label class="check" for={`keep-${f.id}`}>
                <input id={`keep-${f.id}`} type="checkbox" name="keep" value={f.id} checked={kept.has(f.id) || undefined} />
                <span>{f.text}<small>{fromChatLine(f.from, earlier.timeZone)}</small></span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

/** The fields themselves, shared by the real form and the preview's form that sends nothing. */
function ApplyFields(props: ApplyFormProps & { questions: QuickQuestionView[] }) {
  const v = props.state?.values ?? {};
  const answers = props.state?.answers ?? {};
  const missing = new Set(props.state?.missing ?? []);
  const shown = candidateNotices(props.notices);
  const smsNotice = props.smsEnabled ? props.notices.find((n) => n.key === "sms_consent") : undefined;
  const invalid = (field: string) => (missing.has(field) ? "true" : undefined);
  const kept = props.state?.resume ?? null;
  const reading = props.state?.reading ?? null;
  const fromResume = new Set(props.state?.marks?.fromResume ?? []);
  const reused = new Set(props.state?.marks?.reused ?? []);
  const tagOf = (field: string) => (fromResume.has(field) ? FROM_RESUME_TAG : reused.has(field) ? FROM_EARLIER_TAG : null);
  const described = (field: string) => (tagOf(field) ? `${field}-tag` : undefined);
  const checking = !!reading && reading.outcome === "read";
  // The words of an older one-box form go back into the first question, so nothing typed is lost.
  const guided = (key: NoResumeKey) => v[`nr_${key}`] || (key === "recentWork" ? v.noResume ?? "" : "");
  const noResumeOpen = missing.has("noResume") || NO_RESUME_QUESTIONS.some((q) => !!guided(q.key));
  const showSummary = !!(v.workSummary ?? "").trim() || checking;
  // Only a form opened from the emailed reuse link lists anything from earlier; a preview never does.
  const earlier = props.preview ? null : props.state?.earlier ?? null;
  return (
    <>
      {reading ? (
        <section class="card resume-card" aria-labelledby="resume-title">
          <h2 id="resume-title">Your resume</h2>
          <p class="read-line" role="status">{reading.outcome === "read" ? <Icon name="check" /> : <Icon name="paperclip" />}<span>{readLine(reading)}</span></p>
          {kept && !noResumeOpen ? null : <NoResumeFold guided={guided} open={noResumeOpen} invalid={missing.has("noResume")} />}
        </section>
      ) : (
        <section class="card resume-card" aria-labelledby="resume-title">
          <h2 id="resume-title">Start with your resume</h2>
          <p>Software reads your resume and fills in this form for you, usually in about 20 seconds. You check every detail before you send, and people at {props.company.name} make every hiring decision.</p>
          {/* The notice at collection comes before the file is chosen: with script, choosing it starts the reading. */}
          <p class="notice" id="resume-notice">{RESUME_READ_NOTICE} See <a href="/privacy">how we handle your information</a>. Rather not? Fill in the form below yourself, or email <ContactLink contact={props.company.contact} /> and a person will help. If you do not send your application, the file and what was read from it are deleted within a day.</p>
          <ResumeInput kept={kept} resumeLost={!!props.state?.resumeLost} />
          <ReadButton read={props.links.read} preview={!!props.preview} />
          <NoResumeFold guided={guided} open={noResumeOpen} invalid={missing.has("noResume")} />
          <p class="meta">Or fill in the form below yourself.</p>
        </section>
      )}
      <h2 id="details-title">{checking ? "Check your details" : "Your details"}</h2>
      {checking ? <p class="meta">We filled these in from your resume. Check each one and change anything that is not right.</p> : null}
      <label for="firstName">First name</label>
      <Tag id="firstName-tag" text={tagOf("firstName")} />
      <input id="firstName" type="text" name="firstName" required autocomplete="given-name" value={v.firstName ?? ""} aria-invalid={invalid("firstName")} aria-describedby={described("firstName")} />
      <label for="lastName">Last name</label>
      <Tag id="lastName-tag" text={tagOf("lastName")} />
      <input id="lastName" type="text" name="lastName" required autocomplete="family-name" value={v.lastName ?? ""} aria-invalid={invalid("lastName")} aria-describedby={described("lastName")} />
      <label for="email">Email</label>
      <Tag id="email-tag" text={tagOf("email")} />
      <input id="email" type="email" name="email" required autocomplete="email" value={v.email ?? ""} aria-invalid={invalid("email")} aria-describedby={described("email")} />
      <label for="phone">Mobile phone (optional)</label>
      <Tag id="phone-tag" text={tagOf("phone")} />
      <input id="phone" type="tel" name="phone" autocomplete="tel" value={v.phone ?? ""} aria-invalid={invalid("phone")} aria-describedby={described("phone")} />
      {smsNotice ? <label class="check"><input type="checkbox" name="smsConsent" value="yes" checked={!!props.state?.smsConsent} /> <span>{smsNotice.text}</span></label> : null}
      <label for="locationText">Where are you based? (city, state)</label>
      <Tag id="locationText-tag" text={tagOf("locationText")} />
      <input id="locationText" type="text" name="locationText" value={v.locationText ?? ""} aria-invalid={invalid("locationText")} aria-describedby={described("locationText")} />
      {showSummary ? (
        <>
          <label for="workSummary">A short summary of your work (optional)</label>
          <Tag id="workSummary-tag" text={tagOf("workSummary")} />
          <textarea id="workSummary" name="workSummary" rows={5} maxlength={WORK_SUMMARY_MAX} aria-invalid={invalid("workSummary")} aria-describedby={described("workSummary")}>{v.workSummary ?? ""}</textarea>
        </>
      ) : null}
      {earlier?.facts.length ? <EarlierFacts company={props.company.name} earlier={earlier} /> : null}
      <QuickQuestions company={props.company.name} questions={props.questions} answers={answers} missing={missing} suggested={new Set(props.state?.marks?.suggested ?? [])} />
      <TransparencyBlock company={props.company} notices={shown} privacyEmail={props.privacyEmail} acknowledged={!!props.state?.acknowledged} missing={missing.has("acknowledged")} resumeLost={!!props.state?.resumeLost} />
    </>
  );
}

/** "Applied to <Company> before?": the emailed link that fills the form with the details on file (S7-F's route). */
function ReuseFold(props: { company: string; action: string }) {
  return (
    <details class="more reuse">
      <summary>Applied to {props.company} before? Use your saved details</summary>
      <form method="post" action={props.action}>
        <label for="reuse-email">The address you applied with</label>
        <input id="reuse-email" type="email" name="email" autocomplete="email" required />
        <button class="btn secondary" type="submit">Send me a link</button>
        <p class="meta">If you applied to {props.company} before, we email a link to the address on file. It opens this form with your saved details, for you to check.</p>
      </form>
    </details>
  );
}

/** The apply form: the steps header, the job's facts, the pre-apply help line, the fields, and (outside a preview) its script. */
export function ApplyFormPage(props: ApplyFormProps) {
  const { preview } = props;
  const questions = formQuestions(props.packet);
  const reading = props.state?.reading ?? null;
  const replace = !!reading && !preview;
  return (
    <Layout title={`${preview ? "Preview: apply" : "Apply"}: ${props.packet.identity.title} at ${props.company.name}`} noindex={!!preview} extraCss={`${JOURNEY_CSS}${APPLY_CSS}`}>
      {preview ? <PreviewNote preview={preview} /> : null}
      {props.flow === "one_visit" ? <Journey steps={["details", "chat", "review"]} current="details" /> : null}
      <p class="back"><a href={props.links.job}><Icon name="arrow-left" />Back to the job</a></p>
      {/* The facts of the job stay in view while applying (Wave 0 item 0.8), pay included wherever the page must show it. */}
      <p class="eyebrow">{props.company.name}</p>
      <h1>Apply: {props.packet.identity.title}</h1>
      <JobFacts packet={props.packet} pay={publicPay(props.packet, props.notices)} />
      {/* One line on how long it takes (plan E8); the resume field and "No resume?" right below say what to send. */}
      <p class="lead">{`${applyTimeLine(props.packet, { companyName: props.company.name, flow: props.flow })} ${props.flow === "one_visit" ? "First, this form; no" : "No"} cover letter needed.`}</p>
      <HelpLine contact={props.company.contact} class="notice" />
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      {!preview && !reading && props.links.reuse && !(props.state?.marks?.reused ?? []).length && !props.state?.earlier ? <ReuseFold company={props.company.name} action={props.links.reuse} /> : null}
      {preview ? (
        <div class="form-preview">
          <fieldset disabled>
            <legend class="sr-only">The form as candidates see it; it sends nothing here</legend>
            <ApplyFields {...props} questions={questions} />
            <button class="btn" type="button" disabled>Send my application</button>
            {props.flow === "one_visit" ? <p class="meta">Next comes a short AI interview with {props.company.name}'s AI assistant. It opens here once your résumé is read, usually within a minute, and its link comes by email too: start it straight away, do it later, or ask for a person instead. Your details go to {props.company.name} now; your interview answers go only when you press Send my answers.</p> : null}
          </fieldset>
        </div>
      ) : (
        <form method="post" action={props.links.apply} enctype="multipart/form-data" data-upload-intent={props.links.uploadIntent}>
          <input type="text" name="website" tabindex={-1} autocomplete="off" style="position:absolute;left:-10000px" aria-label="Leave this field empty" />
          <input type="hidden" name="uploadGrant" value={props.state?.resume?.grant ?? ""} />
          <input type="hidden" name="formOpened" value={props.formOpened} />
          {/* This page showed the reading ("Check your details"): a form sent back says so again only then (20 Oct). */}
          {reading?.outcome === "read" ? <input type="hidden" name="readShown" value="yes" /> : null}
          <ApplyFields {...props} questions={questions} />
          <input type="hidden" name="noticeVersionsShown" value={noticeVersionsFor(props.notices, props.smsEnabled).join(",")} />
          <button class="btn" type="submit">Send my application</button>
          {props.flow === "one_visit" ? <p class="meta">Next comes a short AI interview with {props.company.name}'s AI assistant. It opens here once your résumé is read, usually within a minute, and its link comes by email too: start it straight away, do it later, or ask for a person instead. Your details go to {props.company.name} now; your interview answers go only when you press Send my answers.</p> : null}
          {/* After a reading the résumé field moves below the button, so pressing Enter in a field sends the form, not a new reading. */}
          {replace ? (
            <details class="more replace" open={!!props.state?.resumeLost || undefined}>
              <summary>Use a different resume</summary>
              <ResumeInput kept={props.state?.resume ?? null} resumeLost={!!props.state?.resumeLost} />
              <ReadButton read={props.links.read} preview={false} again />
            </details>
          ) : null}
        </form>
      )}
      {preview ? null : <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_FORM_JS }} />}
    </Layout>
  );
}

/**
 * The form's own styles (Wave S7), passed as the page's styles beside the steps header's: the shared tokens only, no
 * button rules and no motion. The candidate stylesheet in layout.tsx has no room left (weight-guard.test.ts).
 */
export const APPLY_CSS = `
.resume-card .read-line { display: flex; align-items: flex-start; gap: 10px; margin: 0; color: var(--ink); }
.resume-card .read-line .icon { margin-top: 4px; }
.tag { display: inline-flex; align-items: center; width: fit-content; max-width: 100%; margin: 0 0 6px; padding: 2px 10px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-ink); font-size: 13px; font-weight: 600; line-height: 1.5; }
.quick .q-count { margin: 0 0 4px; color: var(--ink-2); font-size: 14.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
ol.questions { display: grid; gap: 12px; margin: 12px 0 0; padding: 0; list-style: none; }
ol.questions > li { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--ground); }
ol.questions legend.question-legend, ol.questions .question-label { display: block; margin: 0 0 6px; color: var(--ink); font-size: 16px; font-weight: 600; }
ol.questions .q-num { margin-right: 8px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
ol.questions .req { color: var(--ink-3); font-size: 14px; font-weight: 400; }
.choices { display: grid; gap: 8px; margin: 10px 0 0; }
.choices.pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.choices.days { grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); }
.choices .slot { min-height: 48px; margin: 0; }
.number-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.number-row input[type=number] { max-width: 220px; }
.number-row span { color: var(--ink-2); }
details.reuse { margin: 16px 0; }
.earlier legend { margin: 0 0 4px; color: var(--ink); font-size: 17px; font-weight: 600; }
.earlier ul { display: grid; gap: 2px; margin: 8px 0 0; padding: 0; list-style: none; }
.earlier .check { margin: 8px 0; }
details.replace { margin-top: 24px; }
.reading { display: grid; gap: 6px; }
`;

/**
 * Direct-to-storage upload (founder decision 2): with script, the résumé goes from the browser straight to storage
 * under a short-lived, single-object authorization and the form carries only a sealed grant; without script, or if
 * the upload fails, the form posts the file itself as before. Plain ES5, no inline handlers (the policy forbids them),
 * no third-party code, nothing about the person leaves the page except the file's name, size and type (and the form's
 * own sealed "opened at" value, so a form opened before a closing date can still upload).
 *
 * Wave S7: choosing a file starts "Read my resume" at once (the button's own address), the button that was pressed
 * decides where the form goes after the upload, the buttons lock against a second press ("Sending…" on the button),
 * and a page brought back from the browser's history unlocks them.
 */
export const APPLY_UPLOAD_JS = `(function(){
var form=document.querySelector('form[data-upload-intent]');if(!form||!window.fetch||!window.FormData){return;}
var input=form.querySelector('input[type=file][name=resume]');var grant=form.querySelector('input[name=uploadGrant]');var opened=form.querySelector('input[name=formOpened]');var note=document.getElementById('upload-note');
var read=form.querySelector('button[data-read]');var buttons=form.querySelectorAll('button[type=submit]');var home=form.getAttribute('action');
if(!input||!grant){return;}
var busy=false;
function say(t){if(note){note.textContent=t;}}
function lock(on){for(var i=0;i<buttons.length;i++){buttons[i].disabled=on;}}
function send(action){if(action){form.setAttribute('action',action);}form.submit();}
window.addEventListener('pageshow',function(e){if(e.persisted){busy=false;lock(false);if(home){form.setAttribute('action',home);}}});
input.addEventListener('change',function(){if(!(input.files&&input.files.length)){return;}if(grant.value){grant.value='';say('');}if(read&&!busy){if(form.requestSubmit){form.requestSubmit(read);}else{read.click();}}});
function fallback(file,action){form.removeAttribute('data-upload-intent');if(file.size>4*1024*1024){say('The direct upload did not work. Files over 4 MB can only be sent by the direct upload: please try again in a moment, or choose a smaller file.');busy=false;lock(false);return;}send(action);}
form.addEventListener('submit',function(ev){
if(busy){ev.preventDefault();return;}
var sub=ev.submitter||null;var reading=!!(sub&&sub.hasAttribute('data-read'));var action=sub?sub.getAttribute('formaction'):null;
var file=input.files&&input.files[0];
if(!file||grant.value){busy=true;if(reading){say('Reading your resume… This usually takes about 20 seconds.');}else if(sub){sub.textContent='Sending…';}window.setTimeout(function(){lock(true);},0);return;}
ev.preventDefault();busy=true;lock(true);say('Uploading your resume…');
fetch(form.getAttribute('data-upload-intent'),{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({filename:file.name,size:file.size,type:file.type,formOpened:opened?opened.value:''})})
.then(function(r){return r.json().then(function(j){if(!r.ok){throw new Error((j&&j.error&&j.error.message)||'The upload was refused.');}return j;});})
.then(function(j){return fetch(j.url,{method:j.method,headers:j.headers,body:file}).then(function(r){if(!r.ok){throw new Error('The upload did not complete.');}grant.value=j.grant;});})
.then(function(){input.value='';say(reading?'Reading your resume… This usually takes about 20 seconds.':'Resume uploaded.');if(sub&&!reading){sub.textContent='Sending…';}send(action);})
.catch(function(e){say((e&&e.message)||'The upload did not work.');fallback(file,action);});
});
})();`;

/** "N of M answered" under "Questions from <Company>", kept up to date as the candidate answers (ES5, no inline handlers). */
export const APPLY_COUNT_JS = `(function(){
var list=document.querySelector('ol.questions');var count=document.getElementById('q-count');if(!list||!count){return;}
var items=list.querySelectorAll('li[data-field]');var suffix=count.getAttribute('data-suffix')||'';
function answered(li){var els=li.querySelectorAll('input');for(var i=0;i<els.length;i++){var el=els[i];if(el.type==='radio'||el.type==='checkbox'){if(el.checked){return true;}}else if(el.value&&el.value.replace(/\\s+/g,'')!==''){return true;}}return false;}
function recount(){var n=0;for(var i=0;i<items.length;i++){if(answered(items[i])){n++;}}var words=n+' of '+items.length+' answered'+suffix;if(count.textContent!==words){count.textContent=words;}}
list.addEventListener('change',recount);
})();`;

/** The form's one script: the upload and the count. */
export const APPLY_FORM_JS = `${APPLY_UPLOAD_JS}\n${APPLY_COUNT_JS}`;

/* ------------------------------------------------------------------------------------------------------------ */
/* What a posted form says                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

type QuickProblem = { field: string; question: string; problem: string };

/**
 * A posted apply form, read the same way by "Send my application", "Read my resume" and the page that waits for the
 * reading: the typed values, every answer (by question key), the eligibility answers as the server has always read them
 * (`elig_<key>`), the company's quick answers that are answers the question takes (`q_<key>`: one of its options, or a
 * number within its limits) and the ones that are not, and the form's hidden fields. Wave S8: `reuse`, the sealed reuse
 * link a form opened from it carries, and `keep`, the ids of the earlier facts still ticked (ids only, never words).
 */
export type PostedApplyForm = {
  values: Record<string, string>;
  answers: Record<string, string | string[]>;
  eligibilityAnswers: Record<string, unknown>;
  quickAnswers: Record<string, string>;
  quickProblems: QuickProblem[];
  acknowledged: boolean;
  smsConsent: boolean;
  grant: string;
  formOpened: string;
  website: string;
  reuse: string;
  keep: string[];
};

function bodyString(body: Record<string, unknown>) {
  return (k: string): string => {
    const v = body[k];
    if (typeof v === "string") return v;
    return Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
  };
}

/** Why a typed number is not one the question takes, in the words the error line uses; null when it is fine. */
function numberProblem(q: QuickQuestionView, typed: string): string | null {
  const cleaned = typed.replace(/[,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return "a number";
  const n = Number(cleaned);
  const range = q.min !== null && q.max !== null ? `a number from ${q.min} to ${q.max}` : null;
  if (q.min !== null && n < q.min) return range ?? `a number of at least ${q.min}`;
  if (q.max !== null && n > q.max) return range ?? `a number of at most ${q.max}`;
  return null;
}

export function postedApplyForm(body: Record<string, unknown>, questions: QuickQuestionView[], smsEnabled: boolean): PostedApplyForm {
  const str = bodyString(body);
  // A browser sends a text box's line breaks as CRLF; the summary is kept (and compared with the résumé's) with plain ones.
  const values: Record<string, string> = { firstName: str("firstName"), lastName: str("lastName"), email: str("email"), phone: str("phone"), locationText: str("locationText"), noResume: str("noResume"), workSummary: str("workSummary").replace(/\r\n?/g, "\n").slice(0, WORK_SUMMARY_MAX + 500) };
  for (const q of NO_RESUME_QUESTIONS) values[`nr_${q.key}`] = str(`nr_${q.key}`);
  const answers: Record<string, string | string[]> = {};
  const eligibilityAnswers: Record<string, unknown> = {};
  const quickAnswers: Record<string, string> = {};
  const quickProblems: QuickProblem[] = [];
  for (const q of questions) {
    const raw = body[q.field];
    if (q.source === "eligibility") {
      if (Array.isArray(raw)) eligibilityAnswers[q.key] = answers[q.key] = raw.filter((x): x is string => typeof x === "string");
      else if (typeof raw === "string" && raw !== "") eligibilityAnswers[q.key] = answers[q.key] = raw;
      continue;
    }
    const typed = (typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "").trim();
    if (!typed) continue;
    if (q.kind === "choice") {
      // only an option the question offers; anything else was not typed on this page
      const option = q.options.find((o) => o === typed);
      if (option) answers[q.key] = quickAnswers[q.key] = option;
      continue;
    }
    answers[q.key] = typed.slice(0, 40);
    const problem = numberProblem(q, typed);
    if (problem) quickProblems.push({ field: q.field, question: q.question, problem });
    else quickAnswers[q.key] = typed.slice(0, 40);
  }
  const reuse = str("reuse");
  const ticked = Array.isArray(body.keep) ? body.keep : [body.keep];
  const keep = [...new Set(ticked.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 40))].slice(0, 20);
  return {
    values,
    answers,
    eligibilityAnswers,
    quickAnswers,
    quickProblems,
    acknowledged: str("acknowledged") === "yes",
    // While texting is off (decision M2) the checkbox is not on the page, and a posted value is ignored: no consent is recorded and no event is emitted.
    smsConsent: smsEnabled && str("smsConsent") === "yes",
    grant: str("uploadGrant"),
    formOpened: str("formOpened"),
    website: str("website"),
    // a link longer than any sealed one is not one (services/profile-facts.ts refuses it too), so it is not carried on
    reuse: reuse.length <= 2000 ? reuse : "",
    keep,
  };
}

/** The error line for quick answers that are not ones the question takes. */
function quickProblemLine(problems: QuickProblem[]): string {
  return `Please check your ${problems.length === 1 ? "answer" : "answers"}: ${problems.map((p) => `"${p.question}" needs ${p.problem}`).join("; ")}.`;
}

/**
 * The form with a reading applied (`fill`), or compared with it (at Send): a detail the candidate left empty takes the
 * résumé's value, and a quick question left unanswered takes the résumé's suggestion (services/apply-details.ts,
 * `suggestQuickAnswer`). Returned with the fields whose value is still the résumé's: those are marked on the page, and
 * at Send they are `answers.fromCv`. Nothing the candidate typed is ever replaced.
 */
export function withResumeReading(form: { values: Record<string, string>; answers: Record<string, string | string[]> }, reading: ResumeReading | null, questions: QuickQuestionView[], opts: { fill: boolean; now?: Date }): { values: Record<string, string>; answers: Record<string, string | string[]>; fromResume: string[]; suggested: string[] } {
  const values = { ...form.values };
  const answers = { ...form.answers };
  const fromResume: string[] = [];
  const suggested: string[] = [];
  if (!reading || reading.outcome !== "read" || !reading.details) return { values, answers, fromResume, suggested };
  for (const field of DETAIL_FIELDS) {
    const cv = reading.details[field];
    if (!cv) continue;
    const typed = (values[field] ?? "").trim();
    if (!typed && opts.fill) {
      values[field] = cv;
      fromResume.push(field);
    } else if (typed === cv.trim()) fromResume.push(field);
  }
  for (const q of questions) {
    const suggestion = suggestQuickAnswer(q, reading.facts, opts.now);
    if (!suggestion) continue;
    const current = answers[q.key];
    if (!hasAnswer(current) && opts.fill) {
      answers[q.key] = suggestion;
      suggested.push(q.field);
    } else if (current === suggestion) suggested.push(q.field);
  }
  return { values, answers, fromResume, suggested };
}

/**
 * The details an earlier application to this company filled in (S7-F's link), marked "From your earlier application";
 * given the link itself (Wave S8), also the facts the candidate's earlier chats here taught their record, every one
 * ticked to start with.
 */
export function reusedState(details: ReusedDetails, link?: { token: string; timeZone: string }): Partial<ApplyFormState> {
  const values: Record<string, string> = { firstName: details.firstName, lastName: details.lastName, email: details.email, phone: details.phone ?? "", locationText: details.locationText ?? "", workSummary: details.workSummary ?? "" };
  const earlier: EarlierFactsState | null = link && details.facts.length ? { token: link.token, facts: details.facts, kept: details.facts.map((f) => f.id), timeZone: link.timeZone } : null;
  return { values, marks: { reused: DETAIL_FIELDS.filter((f) => !!values[f]?.trim()) }, ...(earlier ? { earlier } : {}) };
}

/**
 * The earlier facts a posted form shows again (a reading, a form sent back, the page that waits): the link it carries is
 * opened again, so only what that link still opens is listed, ticked as the candidate left it. Null without a link.
 */
async function earlierFormState(container: Container, job: Job, posted: Pick<PostedApplyForm, "reuse" | "keep">): Promise<EarlierFactsState | null> {
  if (!posted.reuse) return null;
  const details = await reusedDetailsFor(container, { companyId: job.company.id, roleId: job.role.id, token: posted.reuse });
  if (!details?.facts.length) return null;
  const ticked = new Set(posted.keep);
  return { token: posted.reuse, facts: details.facts, kept: details.facts.filter((f) => ticked.has(f.id)).map((f) => f.id), timeZone: job.company.timezone };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* "Reading your resume…"                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** Everything the candidate entered, carried through the waiting page unchanged. */
function HiddenForm(props: { posted: PostedApplyForm; questions: QuickQuestionView[]; grant: string; formOpened: string }) {
  const { posted } = props;
  return (
    <>
      {Object.entries(posted.values).filter(([, v]) => v !== "").map(([k, v]) => <input type="hidden" name={k} value={v} />)}
      {props.questions.flatMap((q) => {
        const a = posted.answers[q.key];
        return (Array.isArray(a) ? a : a ? [a] : []).map((x) => <input type="hidden" name={q.field} value={x} />);
      })}
      {posted.acknowledged ? <input type="hidden" name="acknowledged" value="yes" /> : null}
      {posted.smsConsent ? <input type="hidden" name="smsConsent" value="yes" /> : null}
      <input type="hidden" name="uploadGrant" value={props.grant} />
      <input type="hidden" name="formOpened" value={props.formOpened} />
      {/* Wave S8: the reuse link and the earlier facts still ticked go on with the form, ids only. */}
      {posted.reuse ? <input type="hidden" name="reuse" value={posted.reuse} /> : null}
      {posted.reuse ? posted.keep.map((id) => <input type="hidden" name="keep" value={id} />) : null}
    </>
  );
}

/**
 * The page shown while a slow reading finishes (the request already waited about 15 seconds). With script it asks
 * every three seconds and moves on by itself; without, Continue shows the details once they are ready (or this page again,
 * a little later), and "Fill it in myself instead" goes on at once. It never waits forever (20 Oct, R20-3): about 75
 * seconds after asking, or as soon as the reading failed, both go on to the form to fill in. The résumé stays attached.
 */
export function ReadingPage(props: { company: { name: string }; title: string; flow: ApplyFlowView; links: { details: string; readStatus: string }; posted: PostedApplyForm; questions: QuickQuestionView[]; grant: string; filename: string; formOpened: string; still: boolean }) {
  return (
    <Layout title={`Reading your resume: ${props.title} at ${props.company.name}`} extraCss={`${JOURNEY_CSS}${APPLY_CSS}`}>
      {props.flow === "one_visit" ? <Journey steps={["details", "chat", "review"]} current="details" /> : null}
      <p class="eyebrow">{props.company.name}</p>
      <h1>Reading your resume</h1>
      <div class="card reading" role="status" id="read-status">
        <p><strong>{props.still ? `Still reading ${props.filename}…` : `Reading ${props.filename}…`}</strong></p>
        <p>Software is filling in your details from your resume. This usually takes about 20 seconds.</p>
        <p class="meta" id="read-next">Press Continue when you are ready. If it is not done yet, this page asks you to wait a little longer; after about a minute, Continue takes you on to fill in your details yourself.</p>
      </div>
      <form method="post" action={props.links.details} data-read-status={props.links.readStatus}>
        <HiddenForm posted={props.posted} questions={props.questions} grant={props.grant} formOpened={props.formOpened} />
        <button class="btn" type="submit">Continue</button>
        <button class="btn secondary" type="submit" name="skip" value="yes">Fill it in myself instead</button>
      </form>
      <p class="meta">Your resume stays attached either way. Nothing goes to {props.company.name} until you press Send my application.</p>
      <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_READ_WAIT_JS }} />
    </Layout>
  );
}

/**
 * Asks every three seconds whether the reading is done and goes on once it is (ES5, no inline handlers). `gave_up`, or
 * no answer within its tries (about 90 seconds), goes on as "Fill it in myself instead" does (`skip=yes`), so the page
 * never waits forever. A busy answer (429, 5xx) or no answer at all is asked again; only a grant that no longer opens
 * (404) stops the asking and leaves the two buttons.
 */
export const APPLY_READ_WAIT_JS = `(function(){
var form=document.querySelector('form[data-read-status]');if(!form||!window.fetch){return;}
var url=form.getAttribute('data-read-status');var grant=form.querySelector('input[name=uploadGrant]');var next=document.getElementById('read-next');
if(next){next.textContent='This page moves on by itself when it is done, within about a minute.';}
var tries=0;var done=false;
form.addEventListener('submit',function(){done=true;});
function go(skip){done=true;if(skip){var s=document.createElement('input');s.type='hidden';s.name='skip';s.value='yes';form.appendChild(s);}form.submit();}
function again(){if(done){return;}if(tries<30){window.setTimeout(tick,3000);}else{go(true);}}
function tick(){if(done){return;}tries++;
fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({grant:grant?grant.value:''})})
.then(function(r){if(r.status===404){return {state:'unknown'};}if(!r.ok){throw new Error('busy');}return r.json();})
.then(function(j){if(done){return;}if(j&&j.state==='done'){go(false);return;}if(j&&j.state==='gave_up'){go(true);return;}if(j&&j.state==='unknown'){if(next){next.textContent='Press Continue, or Fill it in myself instead.';}return;}again();})
.catch(function(){again();});
}
window.setTimeout(tick,1500);
})();`;

/* ------------------------------------------------------------------------------------------------------------ */
/* The receipt and the routes                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The receipt everyone sees after sending the form (Wave 0 item 0.1): new or repeat, the page is the same, and the
 * status link only ever travels by email to the address on file. The address shown is masked and carried for a
 * short while in a sealed cookie the browser cannot read, never in the URL.
 */
export const RECEIPT_COOKIE = "ros_applied";
const RECEIPT_PURPOSE = "application-receipt";
const RECEIPT_TTL_MS = 30 * 60_000;
/**
 * `next` is what the receipt says comes next (20 Oct 2026, R20-12): `interview` (the waiting room), `check_email` (the
 * plain receipt: also the neutral words for a must-have answer, E7), `held`, `used_up` (Q17: the link follows by email)
 * or `paused` (the company's trial ended: the link comes by email). `wait`: what the waiting room waits for, sealed in the
 * cookie: a new address's application, a repeat's or a known address's detached interview (Q14, 21 Oct), or for a bot
 * an id that names nothing; `until`: the waiting room says "preparing" until then whatever is stored, the same short
 * random wait for every one of them (about as long as a reading takes; founder 21 Oct: "same timing"). All have the same
 * shape, so the sealed value tells nothing either. Cookies from before 20 October say "review" or
 * "conversation_by_email" and read as `check_email` and `used_up`.
 */
type ReceiptNext = "interview" | "check_email" | "held" | "used_up" | "paused";
type ReceiptPayload = { v: 1; roleId: string; to: string; exp: number; next?: ReceiptNext | "review" | "conversation_by_email"; wait?: string; until?: number };

function receiptPath(slug: string, roleId: string): string {
  return `/careers/${slug}/jobs/${roleId}/applied`;
}

/**
 * Sends the browser to the receipt or the waiting room, with the masked address it shows. `wait`, for the waiting room:
 * what it waits for (an application, or a detached interview; null for a bot or a repeat past the day's conversations:
 * an id of nothing). Every one says "preparing" for a short random wait first (40 to 90 seconds), and then waits for
 * what it names, so a new address and a known one open alike (Q14): never sooner than that, and a detached interview
 * waits for what a new address's own waits for (services/apply-conversation.ts, `interviewWaitFor`).
 */
function toReceipt(c: Context<Vars>, job: { company: { slug: string }; role: { id: string } }, typedEmail: string, next: ReceiptNext = "check_email", wait?: string | null) {
  const container = c.get("container");
  const path = receiptPath(job.company.slug, job.role.id);
  const now = container.engine.clock().getTime();
  const waiting = next === "interview" ? { wait: wait ?? uuidv7(), until: now + LOOK_ALIKE_MIN_MS + randomInt(LOOK_ALIKE_SPREAD_MS) } : {};
  const payload: ReceiptPayload = { v: 1, roleId: job.role.id, to: maskEmail(typedEmail), exp: now + RECEIPT_TTL_MS, next, ...waiting };
  setCookie(c, RECEIPT_COOKIE, sealPayload(RECEIPT_PURPOSE, payload, container.env.SESSION_SECRET), { httpOnly: true, sameSite: "Lax", secure: container.env.NODE_ENV === "production", path, maxAge: RECEIPT_TTL_MS / 1000 });
  return c.redirect(path);
}

/** Opens the AI interview from the waiting room: its introduction says the application is sent and where its link went (plan E1). */
function toInterview(c: Context<Vars>, token: string, maskedTo: string | null) {
  const container = c.get("container");
  const path = screenPath(token);
  if (maskedTo) {
    const payload: ConversationPayload = { v: 1, token, to: maskedTo, exp: container.engine.clock().getTime() + RECEIPT_TTL_MS };
    setCookie(c, CONVERSATION_COOKIE, sealPayload(CONVERSATION_PURPOSE, payload, container.env.SESSION_SECRET), { httpOnly: true, sameSite: "Lax", secure: container.env.NODE_ENV === "production", path, maxAge: RECEIPT_TTL_MS / 1000 });
  }
  return c.redirect(path);
}

/**
 * The waiting room's grant (20 Oct 2026, R20-12): what it waits for (`a`), its role, until when it says "preparing"
 * whatever is stored (`u`, as the cookie's `until`) and when it stops working (the receipt's half hour), sealed with the
 * session secret like the upload grant and the receipt, and carried in the page. Only a first application from a new
 * address names its own; a repeat or an address the company had (Q14, founder 21 Oct) names a detached interview made
 * for this visit, which opens the same way after the same wait, so nobody can open another person's interview by typing
 * their email, and nothing tells the two apart; a bot's names nothing.
 */
const WAIT_PURPOSE = "interview-wait";
type WaitGrant = { v: 1; a: string; r: string; exp: number; u: number };
/** How long every waiting room says "preparing" at least, whatever it waits for: 40 to 90 seconds, as a reading takes (Q14). */
const LOOK_ALIKE_MIN_MS = 40_000;
const LOOK_ALIKE_SPREAD_MS = 50_000;

function openWaitGrant(container: Container, grant: unknown, roleId: string): WaitGrant | null {
  const g = typeof grant === "string" && grant.length < 2000 ? openPayload<WaitGrant>(WAIT_PURPOSE, grant, container.env.SESSION_SECRET, container.engine.clock().getTime()) : null;
  return g?.v === 1 && g.r === roleId && typeof g.a === "string" ? { ...g, u: typeof g.u === "number" ? g.u : 0 } : null;
}

/** Where the waiting room stands: "preparing" until the grant's `u`, then as what it names stands (nothing: "email"). */
async function waitStateOf(container: Container, grant: WaitGrant): Promise<InterviewWait> {
  return grant.u > container.engine.clock().getTime() ? { state: "preparing" } : interviewWaitFor(container.db, grant.a, { storage: container.integrations.storage, now: container.engine.clock() });
}

/** Without JavaScript the résumé travels inside the form itself, which the platform refuses above a few megabytes; this cap gives that case a plain answer (D14). */
export const NO_SCRIPT_MAX_RESUME_BYTES = 4 * 1024 * 1024;

/** The addresses the form and its pages use, all under the job's own. */
function applyLinks(job: Job) {
  const base = `/careers/${job.company.slug}/jobs/${job.role.id}`;
  return { job: base, uploadIntent: `${base}/upload-intent`, apply: `${base}/apply`, read: `${base}/apply/read`, readStatus: `${base}/apply/read-status`, details: `${base}/apply/details`, reuse: `${base}/apply/reuse` };
}

/**
 * Everything the apply form needs that does not change between showing it and showing it again. The line under each
 * eligibility question is in plain words (Wave S2, question-help.ts); the answers are still read by the questions' keys.
 */
function applyFormFor(container: Container, job: Job, flow: ApplyFlowView): Omit<ApplyFormProps, "formOpened"> {
  const links = applyLinks(job);
  return {
    company: { slug: job.company.slug, name: job.company.name, contact: contactLineFor(job.company.settings, container.env) },
    role: { id: job.role.id },
    packet: withPlainQuestionHelp(job.packet),
    notices: jobNotices(job.packet, job.company),
    smsEnabled: container.env.SMS_ENABLED,
    privacyEmail: container.env.PRIVACY_EMAIL,
    flow,
    links: { job: links.job, uploadIntent: links.uploadIntent, apply: links.apply, read: links.read, reuse: links.reuse },
  };
}

/**
 * Whether this submission (or upload) is taken: while the role takes applications, and for a while after its closing
 * date passed when the form was opened before it (plan D7, services/closing-date.ts). A role a person paused or switched
 * off takes nothing new. Once the company's trial has ended (founder decision L-02 B) a form is still taken for the same
 * while when it was opened before the trial's end (`trialGrace`): someone part-way through applying finishes.
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
  // Funnel measurement without identity (correction 14): a random per-visit reference, no candidate data, no client script; the source comes from the tracked-link cookie when there is one.
  void container.integrations.analytics.capture({ name: "application_started", subjectRef: randomToken(12), companyRef: refFor(job.company.id, container.integrations.analyticsSalt), at: new Date().toISOString(), properties: { source: resolveApplicationSource(c, job.role.id).source } }).catch(() => undefined);
  // Applied to this company before (S7-F): the emailed link fills in the details on file, each marked for checking, and
  // (Wave S8) lists what their earlier chats here added, each ticked. Without the link nothing earlier is shown.
  const reuse = c.req.query("reuse") ?? "";
  const reused = reuse ? await reusedDetailsFor(container, { companyId: job.company.id, roleId: job.role.id, token: reuse }) : null;
  if (reuse) c.header("Cache-Control", "no-store");
  return c.html(<ApplyFormPage {...applyFormFor(container, job, APPLY_FLOW)} formOpened={sealFormOpened(container.env.SESSION_SECRET, job.role.id, container.engine.clock())} state={reused ? reusedState(reused, { token: reuse, timeZone: job.company.timezone }) : undefined} />);
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
  const upload = await container.integrations.storage.createUploadUrl(key, { contentType: intent.mime, expiresSeconds: UPLOAD_URL_TTL_SECONDS });
  const grant = container.uploadGrants.seal({ v: 1, companyId: job.company.id, roleId: job.role.id, uploadId, key, filename: intent.filename, mime: intent.mime, size: intent.size, exp: Math.floor(now.getTime() / 1000) + UPLOAD_GRANT_TTL_SECONDS });
  await withTenant(container.db, job.company.id, (tx) => emit(tx, { type: "document.upload_authorized", companyId: job.company.id, actor: { kind: "candidate", id: "applicant" }, subject: { type: "role", id: job.role.id }, payload: { uploadId, extension: intent.extension, sizeBytes: intent.size } }));
  return c.json({ uploadId, url: upload.url, method: upload.method, headers: upload.headers, grant, expiresAt: upload.expiresAt, maxBytes: MAX_RESUME_BYTES });
});

/**
 * Reading a résumé costs a model call: fewer per address than sending forms. Asking whether it is done is cheap, and its
 * limit is the asking's alone: Continue and "Fill it in myself instead" (`…/apply/details`) are not under it (20 Oct).
 */
const READ_POLICY: Policy = { name: "apply.read_resume", rules: [{ by: "ip", windowMs: 3_600_000, limit: 30 }, { by: "role", windowMs: 3_600_000, limit: 600, param: "roleId" }] };
const READ_STATUS_POLICY: Policy = { name: "apply.read_status", rules: [{ by: "ip", windowMs: 3_600_000, limit: 1200 }] };

/**
 * The form after a reading ("Check your details"): the details the candidate left empty filled in from the résumé and
 * marked, the quick questions suggested, the résumé attached. A refused file is not kept: the form says so and asks for
 * another (its quarantined copy is removed with the reading after a day). `reading` null: they chose to fill it in
 * themselves, or the reading could not be asked for.
 */
function checkedForm(container: Container, posted: PostedApplyForm, questions: QuickQuestionView[], upload: { grant: string; filename: string }, reading: ResumeReading | null): { state: Partial<ApplyFormState>; error?: string } {
  const base = { acknowledged: posted.acknowledged, smsConsent: posted.smsConsent, missing: [] as string[] };
  if (reading?.outcome === "refused") {
    return { state: { ...base, values: posted.values, answers: posted.answers, resume: null, resumeLost: false }, error: `We could not use ${upload.filename}. Please choose a different file, or answer the four short questions instead.` };
  }
  const filled = withResumeReading({ values: posted.values, answers: posted.answers }, reading, questions, { fill: true, now: container.engine.clock() });
  return { state: { ...base, values: filled.values, answers: filled.answers, resume: upload, resumeLost: false, marks: { fromResume: filled.fromResume, suggested: filled.suggested }, reading: { filename: upload.filename, outcome: reading ? reading.outcome : "skipped" } } };
}

/**
 * "Read my resume" (Wave S7, spec step 2). The form posts itself here with the file inside it (no script) or with the
 * grant of a file the browser already uploaded. The file is put in quarantine (the form's own copy) and the worker reads
 * it; this request waits up to about 15 seconds for the reading and then shows "Check your details", or the page that
 * waits a little longer. Nothing to read (Enter pressed before choosing a file) shows the form again with a plain line.
 */
candidatePages.post("/careers/:slug/jobs/:roleId/apply/read", rateLimit(READ_POLICY), async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const str = bodyString(body);
  if (!admits(container, job, str("formOpened")).ok) return c.notFound();
  const flow = APPLY_FLOW;
  const form = applyFormFor(container, job, flow);
  const formOpened = str("formOpened") || sealFormOpened(container.env.SESSION_SECRET, job.role.id, container.engine.clock());
  const questions = formQuestions(form.packet);
  const posted = postedApplyForm(body, questions, container.env.SMS_ENABLED);
  if (posted.website) return toReceipt(c, job, posted.values.email);
  const now = container.engine.clock();
  // A form opened from the reuse link lists its earlier facts again, as they were ticked (Wave S8).
  const earlier = await earlierFormState(container, job, posted);
  if (earlier) c.header("Cache-Control", "no-store");
  const show = (error: string, resumeLost: boolean) => c.html(<ApplyFormPage {...form} formOpened={formOpened} error={error} state={{ values: posted.values, answers: posted.answers, acknowledged: posted.acknowledged, smsConsent: posted.smsConsent, missing: [], resume: null, resumeLost, earlier }} />, 400);

  let upload: UploadGrantPayload | null = null;
  const file = postedFile(body);
  if (file) {
    // The file came inside the form: the same checks as a form sent with it, then the app's own quarantined copy and a grant for it.
    if (file.size > NO_SCRIPT_MAX_RESUME_BYTES) return show(file.size > MAX_RESUME_BYTES ? "Resume files must be under 8 MB." : "Files over 4 MB can only be sent by the direct upload, which needs JavaScript. Please choose a smaller file, or try again with JavaScript turned on.", true);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const look = inspectResumeFile(bytes, { mime: file.type, filename: file.name });
    if (!look.ok) return show(look.reason === "unsupported_type" || look.reason === "type_mismatch" ? "Please upload a PDF, Word (.docx), or text file." : `That file cannot be used: ${look.detail}.`, true);
    const uploadId = uuidv7();
    const key = quarantineKey(job.company.id, job.role.id, uploadId, look.extension);
    await container.integrations.storage.put(key, bytes, look.mime);
    await withTenant(container.db, job.company.id, (tx) => emit(tx, { type: "document.upload_authorized", companyId: job.company.id, actor: { kind: "candidate", id: "applicant" }, subject: { type: "role", id: job.role.id }, payload: { uploadId, extension: look.extension, sizeBytes: bytes.byteLength } }));
    upload = { v: 1, companyId: job.company.id, roleId: job.role.id, uploadId, key, filename: file.name.trim().slice(0, 200) || `resume.${look.extension}`, mime: look.mime, size: bytes.byteLength, exp: Math.floor(now.getTime() / 1000) + READ_GRANT_TTL_SECONDS, via: "server", readAskedAt: Math.floor(now.getTime() / 1000) };
  } else {
    const held = heldUpload(container, job, posted.grant);
    if (held) {
      if (await withTenant(container.db, job.company.id, (tx) => uploadAlreadyUsed(tx, { roleId: job.role.id, uploadId: held.uploadId }))) return show(UPLOAD_EXPIRED, true);
      const head = await container.integrations.storage.head(held.key);
      if (!head || head.size === 0) return show("Your uploaded resume did not arrive. Please attach the file again.", true);
      // Checking the details takes as long as it takes: the grant the form carries from here lasts a while longer. It
      // says when the reading was first asked for, so the waiting page gives up on it in time (20 Oct, R20-3): the time
      // the grant already carries, else the reading's first job (a reload posts the upload's own grant again), else now.
      const askedAt = held.readAskedAt ?? (await readingAskedAt(container.db, held)) ?? Math.floor(now.getTime() / 1000);
      upload = { ...held, exp: Math.max(held.exp, Math.floor(now.getTime() / 1000) + READ_GRANT_TTL_SECONDS), readAskedAt: askedAt };
    }
  }
  if (!upload && !file && !posted.grant) {
    // Nothing to read: Enter pressed in a field (the first button of a fresh form is this one), or the form filled in by
    // hand. It is sent exactly as "Send my application" sends it, under the same checks and the same limit.
    const refused = await checkRateLimits(c, [POLICIES.apply]);
    return refused ?? sendApplication(c);
  }
  if (!upload) return show("Choose your resume file first, then press Read my resume. Or fill in the form below yourself and press Send my application.", !!posted.grant);
  const grant = container.uploadGrants.seal(upload);
  const ref = { companyId: upload.companyId, roleId: upload.roleId, uploadId: upload.uploadId, key: upload.key, filename: upload.filename, mime: upload.mime };

  let reading: ResumeReading | null = null;
  try {
    await startResumeReading(container, ref);
    await container.kick();
    // The worker reads it; an inline worker has already finished by now.
    reading = await waitForReading(container.integrations.storage, ref, container.env.WORKER_INLINE ? 0 : READ_WAIT_MS);
    if (!reading) {
      c.header("Cache-Control", "no-store");
      return c.html(<ReadingPage company={job.company} title={job.packet.identity.title} flow={flow} links={applyLinks(job)} posted={posted} questions={questions} grant={grant} filename={upload.filename} formOpened={formOpened} still={false} />);
    }
  } catch (err) {
    // The reading could not even be asked for: the résumé stays attached and the candidate fills in the form.
    console.warn(`[apply] the résumé reading could not be queued: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checked = checkedForm(container, posted, questions, { grant, filename: upload.filename }, reading ?? failedReading(upload.uploadId, now));
  c.header("Cache-Control", "no-store");
  return c.html(<ApplyFormPage {...form} formOpened={formOpened} error={checked.error} state={{ ...checked.state, earlier }} />);
});

/** A reading that did not come (it could not be asked for, or the page stopped waiting): the form says "We could not read … just now". */
function failedReading(uploadId: string, now: Date): ResumeReading {
  return { v: 1, uploadId, outcome: "failed", aiRunId: null, readAt: now.toISOString(), details: null, facts: null };
}

/**
 * "Continue" on the page that waits for a reading: the details once it is done, that page again while it is not. Once
 * the page has waited long enough (`readingGaveUp`, about 75 seconds after asking) Continue always goes on: the form,
 * the résumé attached, and the line that it could not be read just now. The waiting page's script sends the same. It
 * writes nothing and asks no model, so only the candidate pages' own limit applies: the way on never runs out because
 * the waiting pages behind one address used up the asking's limit (20 Oct).
 */
candidatePages.post("/careers/:slug/jobs/:roleId/apply/details", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const str = bodyString(body);
  if (!admits(container, job, str("formOpened")).ok) return c.notFound();
  const flow = APPLY_FLOW;
  const form = applyFormFor(container, job, flow);
  const formOpened = str("formOpened") || sealFormOpened(container.env.SESSION_SECRET, job.role.id, container.engine.clock());
  const questions = formQuestions(form.packet);
  const posted = postedApplyForm(body, questions, container.env.SMS_ENABLED);
  const held = heldUpload(container, job, posted.grant);
  c.header("Cache-Control", "no-store");
  // A form opened from the reuse link lists its earlier facts again, as they were ticked (Wave S8).
  const earlier = await earlierFormState(container, job, posted);
  if (!held) return c.html(<ApplyFormPage {...form} formOpened={formOpened} error={UPLOAD_EXPIRED} state={{ values: posted.values, answers: posted.answers, acknowledged: posted.acknowledged, smsConsent: posted.smsConsent, missing: [], resume: null, resumeLost: true, earlier }} />, 400);
  const reading = await readingFor(container.integrations.storage, held);
  const now = container.engine.clock();
  const gaveUp = readingGaveUp(held, reading, now);
  if (!reading && !gaveUp && str("skip") !== "yes") return c.html(<ReadingPage company={job.company} title={job.packet.identity.title} flow={flow} links={applyLinks(job)} posted={posted} questions={questions} grant={posted.grant} filename={held.filename} formOpened={formOpened} still />);
  const checked = checkedForm(container, posted, questions, { grant: posted.grant, filename: held.filename }, gaveUp ? reading ?? failedReading(held.uploadId, now) : reading);
  return c.html(<ApplyFormPage {...form} formOpened={formOpened} error={checked.error} state={{ ...checked.state, earlier }} />);
});

/**
 * The waiting page's question (with script): is the reading done? Only for the upload the asking page holds. `gave_up`
 * once the page has waited long enough or the reading failed (`readingGaveUp`): the script then goes on to the form.
 */
candidatePages.post("/careers/:slug/jobs/:roleId/apply/read-status", rateLimit(READ_STATUS_POLICY), async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  let raw: unknown = null;
  try { raw = await c.req.json(); } catch { raw = null; }
  const token = (raw as { grant?: unknown } | null)?.grant;
  const held = job && typeof token === "string" ? heldUpload(container, job, token) : null;
  c.header("Cache-Control", "no-store");
  if (!held) return c.json({ state: "unknown" }, 404);
  const reading = await readingFor(container.integrations.storage, held);
  if (readingGaveUp(held, reading, container.engine.clock())) return c.json({ state: "gave_up" });
  return c.json({ state: reading ? "done" : "reading" });
});

/**
 * "Send my application": the form's own address, and "Read my resume" pressed with nothing to read (Enter in a field of
 * a fresh form presses the first button, which is "Read my resume"), so the same checks apply however it was sent.
 */
async function sendApplication(c: Context<Vars>): Promise<Response> {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const str = bodyString(body);
  const admitted = admits(container, job, str("formOpened"));
  if (!admitted.ok) return c.notFound();
  const { company, role, packet } = job;
  const smsEnabled = container.env.SMS_ENABLED;
  const form = applyFormFor(container, job, APPLY_FLOW);
  // A form shown again keeps the moment it was first opened, so the closing date's grace still applies to it.
  const formOpened = str("formOpened") || sealFormOpened(container.env.SESSION_SECRET, role.id, container.engine.clock());
  // The versions recorded as shown are the server's own, computed from the same inputs as the render; a browser cannot claim a different set.
  const noticeVersionsShown = noticeVersionsFor(form.notices, smsEnabled);
  const questions = formQuestions(form.packet);
  const posted = postedApplyForm(body, questions, smsEnabled);
  const { values, answers, acknowledged, smsConsent, eligibilityAnswers } = posted;
  // The four short questions (plan D10), and the one box an older page may still send; stored with the summary every reader uses.
  const noResumeAnswers = noResumeAnswersFrom({ ...Object.fromEntries(NO_RESUME_QUESTIONS.map((q) => [q.key, values[`nr_${q.key}`]])), noResume: values.noResume });
  // A résumé the form already holds (uploaded straight to storage, or read first): its reading, when there is one, marks
  // what came from it (Wave S7), on the page shown again and in the application (`answers.fromCv`).
  const held = heldUpload(container, job, posted.grant);
  const reading = held ? await readingFor(container.integrations.storage, held) : null;
  // A reading counts on this form only if the form showed it (`readShown`, "Check your details"): one that arrived after
  // the candidate went on without it (the page gave up, or "Fill it in myself") filled in nothing, so a form sent back
  // says the résumé is attached, not that it was read, and nothing typed is marked as the résumé's (20 Oct).
  const shown = reading?.outcome === "read" && str("readShown") !== "yes" ? null : reading;
  const marked = withResumeReading({ values, answers }, shown, questions, { fill: false, now: container.engine.clock() });
  const readView: ApplyFormReading | null = held && reading && reading.outcome !== "refused" ? { filename: held.filename, outcome: shown ? reading.outcome : "skipped" } : null;
  // A resume the browser already uploaded stays attached: its grant, still valid for this company and role, goes back into
  // the form. A file posted inside the form (or a grant that no longer opens) cannot be put back, and the page says so.
  const keptResume = held ? { grant: posted.grant, filename: held.filename } : null;
  const resumeLost = !keptResume && (!!postedFile(body) || !!posted.grant);
  // A form opened from the reuse link and sent back lists its earlier facts again, as they were ticked (Wave S8).
  const earlier = await earlierFormState(container, job, posted);
  if (earlier) c.header("Cache-Control", "no-store");
  const state = (missing: string[] = [], resume: Pick<ApplyFormState, "resume" | "resumeLost"> = { resume: null, resumeLost: false }): Partial<ApplyFormState> => ({ values, answers, acknowledged, smsConsent, missing, ...resume, marks: { fromResume: marked.fromResume, suggested: marked.suggested }, reading: resume.resume ? readView : null, earlier });
  const again = (error: string, missing: string[] = [], resume?: Pick<ApplyFormState, "resume" | "resumeLost">) => c.html(<ApplyFormPage {...form} formOpened={formOpened} error={error} state={state(missing, resume)} />, 400);
  // Honeypot: a filled hidden field gets the waiting room a person gets (naming nothing), and nothing is recorded.
  if (posted.website) return toReceipt(c, job, values.email, "interview");
  const fromCv = [...marked.fromResume, ...marked.suggested];
  const workSummary = values.workSummary.trim();
  const parsed = ApplyRequest.safeParse({
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone || undefined,
    locationText: values.locationText || undefined,
    smsConsent,
    answers: eligibilityAnswers,
    noResumeAnswers,
    quickAnswers: Object.keys(posted.quickAnswers).length ? posted.quickAnswers : undefined,
    workSummary: workSummary || undefined,
    fromCv: fromCv.length ? fromCv : undefined,
    noticeVersionsShown,
    acknowledged,
  });
  if (!parsed.success) {
    const missing = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
    const onlyAcknowledgment = missing.length === 1 && missing[0] === "acknowledged";
    const still = keptSentence(resumeLost);
    return again(onlyAcknowledgment ? `One more step: please confirm you have read the notice at the bottom of the form. ${still}` : `${applyFormProblem(missing)} ${still}`, missing, { resume: keptResume, resumeLost });
  }
  // A quick answer the question does not take (a number outside its limits): the form comes back with it marked.
  if (posted.quickProblems.length) return again(`${quickProblemLine(posted.quickProblems)} ${keptSentence(resumeLost)}`, posted.quickProblems.map((p) => p.field), { resume: keptResume, resumeLost });

  let resume: ResumeUpload | null = null;
  let usedUploadId: string | null = null;
  if (posted.grant) {
    // The browser uploaded straight to storage (or the form's reading put it there); the grant names the object. It must be for this company and role.
    const grant = held;
    if (!grant) return again(UPLOAD_EXPIRED);
    // One submission per grant, refused before the file is looked at (services/applications.ts, uploadAlreadyUsed).
    if (await withTenant(container.db, company.id, (tx) => uploadAlreadyUsed(tx, { roleId: role.id, uploadId: grant.uploadId }))) return again(UPLOAD_EXPIRED);
    const head = await container.integrations.storage.head(grant.key);
    if (!head || head.size === 0) return again("Your uploaded resume did not arrive. Please attach the file again.");
    if (head.size > MAX_RESUME_BYTES) {
      await container.integrations.storage.delete(grant.key);
      return again("Resume files must be under 8 MB.");
    }
    resume = { kind: "stored", filename: grant.filename, mime: grant.mime, storageKey: grant.key, sizeBytes: head.size, via: grant.via ?? "direct" };
    usedUploadId = grant.uploadId;
  } else {
    const f = postedFile(body);
    if (f) {
      // The form carried the file itself (no JavaScript, or the direct upload failed): the platform refuses large bodies before this code runs, so the friendly limit is lower (D14).
      if (f.size > NO_SCRIPT_MAX_RESUME_BYTES) return again(f.size > MAX_RESUME_BYTES ? "Resume files must be under 8 MB." : "Files over 4 MB can only be sent by the direct upload, which needs JavaScript. Please choose a smaller file, or try again with JavaScript turned on.");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const look = inspectResumeFile(bytes, { mime: f.type, filename: f.name });
      if (!look.ok) return again(look.reason === "unsupported_type" || look.reason === "type_mismatch" ? "Please upload a PDF, Word (.docx), or text file." : `That file cannot be used: ${look.detail}.`);
      resume = { kind: "bytes", filename: f.name, mime: look.mime, bytes, via: "server" };
    }
  }
  if (!resume && !parsed.data.noResumeAnswers) return again("Upload a resume, or answer at least one of the four short questions about your work.", ["noResume"]);
  // The form's reading of this very upload goes with the application, so it is not read a second time (Wave S7). By the
  // upload, also with no note yet (20 Oct, R20-1): a reading still running, or one whose note never came, is tied at
  // Send when it is there, else by the intake, which waits a little for one still running.
  const formReading = held && usedUploadId === held.uploadId ? { uploadId: held.uploadId, storageKey: held.key, readAskedAt: held.readAskedAt ?? null } : null;
  // What this visit typed, for a repeat's or a known address's detached interview to name (Wave S7, spec steps 4 to 6;
  // Q14, 21 Oct): the CV's lines from the form's own reading of this very upload, the summary they checked and the
  // no-résumé answers, and every form answer as a sentence; never anything on file.
  const readCv = held && usedUploadId === held.uploadId && reading?.outcome === "read" ? reading.cvLines ?? [] : [];
  // A reading the form asked for that had not finished at Send ("Fill it in myself", the page moving on, a quick Send):
  // a repeat's detached interview waits for it and reads its CV lines by the upload, as the intake does (21 Oct, Q14).
  const pendingReading = formReading && !reading && held?.readAskedAt ? { uploadId: formReading.uploadId, readAskedAt: new Date(held.readAskedAt * 1000).toISOString() } : null;
  const typedFacts = {
    cv: [...readCv, ...answerCvLines({ workSummary: parsed.data.workSummary ?? null, noResume: parsed.data.noResumeAnswers ?? null })].slice(0, 20),
    formAnswers: applicationAnswerSentences(packet, { eligibility: eligibilityAnswers, quick: parsed.data.quickAnswers ?? null }).map((s) => s.sentence).slice(0, 20),
  };
  // The earlier facts still ticked on a form opened from the reuse link (Wave S8): the link is opened again, the address
  // typed must be the one on file, and only ids come from the form (services/profile-facts.ts). Without a link, nothing.
  const keeping = await factsToKeep(container, { companyId: company.id, roleId: role.id, token: posted.reuse, typedEmail: parsed.data.email, ids: posted.keep });

  // The consent record carries the address the trusted proxy reports, never one the client wrote into the header.
  const ip = clientIp(c);
  // The source comes from the tracked-link cookie when it names this role (docs/spec/20 items 8 and 19); the token itself is never stored.
  const origin = resolveApplicationSource(c, role.id);
  // The page never shows or links to an existing application (Wave 0 item 0.1), so typing someone else's address changes
  // nothing on their record. A first application waits on the page for its own AI interview (20 Oct 2026, R20-12); a
  // repeat or an address the company already had gets the same waiting room, which opens a detached AI interview whose
  // answers join only when the address owner confirms them by email (Q14, founder 21 Oct; `applyVisitNext`).
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
      quickAnswers: parsed.data.quickAnswers,
      workSummary: parsed.data.workSummary ?? null,
      fromCv: parsed.data.fromCv,
      formReading,
      resume,
      ip,
    }, { kind: "candidate", id: "applicant" }, { closingGrace: admitted.late, trialGrace: admitted.trialGrace });
    // Kept only on a new application of the very person the link is for (a repeat submission changes nothing on file):
    // this application's own answers, which its chat reads as the candidate's own words and does not ask again.
    const kept = keeping && !created.duplicate && created.candidate.id === keeping.candidateId ? keptFactsOf(keeping.facts, container.engine.clock().toISOString()) : [];
    await keepFactsOn(tx, { applicationId: created.application.id, facts: kept });
    // The waiting room or a plain receipt: decided in this transaction, from what was typed.
    return applyVisitNext(tx, container, { application: created.application, duplicate: created.duplicate, knownPerson: created.knownPerson, company, role, packet, eligibilityAnswers, quickAnswers: parsed.data.quickAnswers ?? null, typedFirstName: parsed.data.firstName, typedFacts: chatFactsWithKept(typedFacts, kept), pendingReading, trialPaused: admitted.trialGrace });
  });
  await container.kick();
  clearApplicationSource(c);
  // An answer that did not match an eligibility question gets the neutral receipt (E7): nothing said about why.
  return next.kind === "interview" ? toReceipt(c, job, parsed.data.email, "interview", next.applicationId ?? next.conversationId) : toReceipt(c, job, parsed.data.email, next.reason);
}

candidatePages.post("/careers/:slug/jobs/:roleId/apply", rateLimit(POLICIES.apply), (c) => sendApplication(c));

/** What each field the form checks needs, in the words the error line uses (known-bugs row 72). */
const FIELD_PROBLEM: Record<string, string> = {
  firstName: "your first name",
  lastName: "your last name",
  email: "a valid email address",
  phone: "a phone number of at least 7 digits, or leave it empty",
  locationText: "a shorter place (120 characters at most)",
  workSummary: `a shorter summary of your work (${WORK_SUMMARY_MAX} characters at most)`,
  acknowledged: "the confirmation box at the bottom of the form",
};

/**
 * The error line over a form sent back: it names exactly the fields that are highlighted, so a short phone number or a
 * long place is never blamed on the name, the email or the confirmation box.
 */
export function applyFormProblem(missing: readonly string[]): string {
  const named = missing.map((m) => FIELD_PROBLEM[m]).filter((x): x is string => !!x);
  if (!named.length) return "Please check the highlighted fields and send the form again.";
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `Please check the highlighted ${named.length === 1 ? "field" : "fields"}: ${list}.`;
}

/**
 * The receipt (Wave 0 item 0.1), in plain words and with no loader: it never names a status link. An answer that did not
 * match a must-have question (E7) and a waiting room that stopped waiting read the same: check your email, the team
 * reviews, you hear either way. When the month's AI interviews are used up (Q17) or the trial ended, it says the AI
 * interview's link comes by email. Worked out from what was typed, so a known address reads as a new one (Q14).
 */
function Receipt(props: { company: { slug: string; name: string }; role: { id: string }; packet: RolePacket; to: string | null; next: Exclude<ReceiptNext, "interview"> }) {
  const minutes = props.packet.screening.maxMinutes;
  return (
    <Layout title="Check your email">
      <p class="eyebrow"><a href={`/careers/${props.company.slug}/jobs/${props.role.id}`}>{props.packet.identity.title}</a> · {props.company.name}</p>
      <h1>Thanks for applying</h1>
      <div class="card" role="status">
        <p><strong>Check your email.</strong> Your own link to this application goes to {props.to ?? "the email address you gave"}.</p>
        <p>Keep that email. The link is how you check where things stand, withdraw, or ask about your information. There is no account or password.</p>
      </div>
      <h2>What happens next</h2>
      <ol class="steps">
        {props.next === "used_up" ? <li>Your next step is a short AI interview with {props.company.name}'s AI assistant, about {minutes} minutes. We email you its link as soon as it is ready. You can skip any question, or ask for a person instead.</li> : null}
        {props.next === "paused" ? <li>Your next step is a short AI interview with {props.company.name}'s AI assistant, about {minutes} minutes. We email you its link shortly; do it whenever suits you, or ask for a person instead.</li> : null}
        <li>The hiring team at {props.company.name} reviews your application. People make every decision.</li>
        <li>You hear from us by email either way.</li>
      </ol>
      <NoEmail />
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/**
 * "No email?" one click away (founder brief, 14 October 2026). The earlier-emails line is true for a first application
 * and a repeat alike: a repeat's reminder goes at most once a day, so it may be in an earlier email.
 */
function NoEmail() {
  return (
    <details class="more">
      <summary>No email?</summary>
      <p>It can take a few minutes. Look in your spam or promotions folder too. If you applied for this job before, look in our earlier emails too: we send the link again at most once a day.</p>
      <p>If it still has not arrived, we can send your link again.</p>
      <a class="btn secondary" href="/c/link-request">Send my link again</a>
    </details>
  );
}

const WAIT_CSS = `.wait{display:flex;gap:14px;align-items:flex-start}.loader{flex:none;width:22px;height:22px;margin-top:2px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:ros-spin .9s linear infinite}@keyframes ros-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.loader{animation:none}}`;

/**
 * The waiting room (20 Oct 2026, R20-12): after Send the page waits for this application's AI interview (the résumé read
 * and the fit check done, usually about a minute) and opens it by itself; the one email carries the same link, for
 * later. With script it asks `…/applied/status` every two seconds, then every five, and stops after about twelve
 * minutes with "check your email", its loader stopped. Without script there is no loader and no promise that the page
 * moves: "Start my interview" opens it when it is ready, or shows this page again. The grant names this application
 * only (`WaitGrant`), or for a repeat or a known address a detached interview (Q14), or for a bot nothing; the page is
 * the same, byte for byte apart from the grant, and so is what follows (a detached interview opens the same way).
 */
function WaitingRoom(props: { company: { slug: string; name: string }; role: { id: string }; packet: RolePacket; to: string | null; grant: string; again?: boolean }) {
  const base = receiptPath(props.company.slug, props.role.id);
  return (
    <Layout title="Preparing your AI interview" extraCss={WAIT_CSS}>
      <p class="eyebrow"><a href={`/careers/${props.company.slug}/jobs/${props.role.id}`}>{props.packet.identity.title}</a> · {props.company.name}</p>
      <h1>Thanks for applying</h1>
      <div class="card wait" role="status" aria-live="polite">
        {/* Shown by the script only: without it nothing on the page moves by itself. */}
        <span class="loader" aria-hidden="true" hidden />
        <div>
          <p><strong id="wait-line">We're preparing your AI interview…</strong></p>
          <p id="wait-more">{props.again ? "It is not ready yet. It usually takes about a minute: press Start my interview again in a moment." : "We are reading your application so the questions fit your experience. It usually takes about a minute: press Start my interview in a moment to begin."}</p>
        </div>
      </div>
      <p>Your next step is a short interview with {props.company.name}'s AI assistant: a written chat of about {props.packet.screening.maxMinutes} minutes. You can skip any question, or ask for a person instead.</p>
      <p>We've also emailed you the link{props.to ? ` (to ${props.to})` : ""}, so you can join later from there.</p>
      <form method="post" action={`${base}/start`} data-wait-status={`${base}/status`} data-wait-done={base}>
        <input type="hidden" name="grant" value={props.grant} />
        <button class="btn" type="submit">Start my interview</button>
      </form>
      <NoEmail />
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
      <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: APPLY_WAIT_JS }} />
    </Layout>
  );
}

/**
 * Asks whether the AI interview is ready (ES5, no inline handlers): every two seconds for two minutes, then every five,
 * about twelve minutes in all (180 tries). It shows the loader and says the page opens the interview by itself; giving
 * up, it hides the loader again. `ready` presses Start my interview (which opens it); anything other than `preparing`
 * loads the receipt again, which then says plainly what happens next; a busy answer or none at all is asked again.
 */
export const APPLY_WAIT_JS = `(function(){
var form=document.querySelector('form[data-wait-status]');if(!form||!window.fetch){return;}
var url=form.getAttribute('data-wait-status');var done=form.getAttribute('data-wait-done');var grant=form.querySelector('input[name=grant]');
var line=document.getElementById('wait-line');var more=document.getElementById('wait-more');var loader=document.querySelector('.wait .loader');
if(loader){loader.hidden=false;}
if(more){more.textContent='We are reading your application so the questions fit your experience. It usually takes about a minute, and this page opens your interview by itself.';}
var tries=0;var stopped=false;
form.addEventListener('submit',function(){stopped=true;});
function again(){if(stopped){return;}tries++;if(tries>=180){stopped=true;if(loader){loader.hidden=true;}if(line){line.textContent='Your AI interview link is in your email.';}if(more){more.textContent='It is taking longer than usual. Use the link in our email whenever you are ready, or press Start my interview.';}return;}window.setTimeout(tick,tries<60?2000:5000);}
function tick(){if(stopped){return;}
fetch(url,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({grant:grant?grant.value:''})})
.then(function(r){if(r.status===404){return {state:'gone'};}if(!r.ok){throw new Error('busy');}return r.json();})
.then(function(j){if(stopped){return;}if(j&&j.state==='ready'){stopped=true;form.submit();return;}if(j&&j.state==='preparing'){again();return;}stopped=true;window.location.assign(done);})
.catch(function(){again();});
}
window.setTimeout(tick,1500);
})();`;

/** What the receipt shows for a waiting room that is not waiting any more (or never was). */
function receiptFor(state: InterviewWait["state"]): Exclude<ReceiptNext, "interview"> {
  return state === "used_up" ? "used_up" : "check_email";
}

/**
 * The receipt or the waiting room, as the cookie (or the grant a "Start my interview" press carried) and the application
 * stand now; a ready interview opens at once.
 */
async function receiptPage(c: Context<Vars>, job: Job, opts: { again?: boolean; grant?: WaitGrant } = {}): Promise<Response> {
  const container = c.get("container");
  const sealed = openPayload<ReceiptPayload>(RECEIPT_PURPOSE, getCookie(c, RECEIPT_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  const mine = sealed?.v === 1 && sealed.roleId === job.role.id;
  const to = mine && typeof sealed.to === "string" ? sealed.to : null;
  c.header("Cache-Control", "no-store");
  const props = { company: job.company, role: job.role, packet: job.packet, to };
  const waitFor: WaitGrant | null = opts.grant ?? (mine && sealed.next === "interview" && typeof sealed.wait === "string" ? { v: 1, a: sealed.wait, r: job.role.id, exp: sealed.exp, u: typeof sealed.until === "number" ? sealed.until : 0 } : null);
  if (waitFor) {
    const wait = await waitStateOf(container, waitFor);
    if (wait.state === "ready") return toInterview(c, wait.token, to);
    if (wait.state === "preparing") return c.html(<WaitingRoom {...props} grant={sealPayload<WaitGrant>(WAIT_PURPOSE, waitFor, container.env.SESSION_SECRET)} again={opts.again} />);
    return c.html(<Receipt {...props} next={receiptFor(wait.state)} />);
  }
  const next = !mine ? "check_email" : sealed.next === "conversation_by_email" || sealed.next === "used_up" ? "used_up" : sealed.next === "paused" ? "paused" : "check_email";
  return c.html(<Receipt {...props} next={next} />);
}

candidatePages.get("/careers/:slug/jobs/:roleId/applied", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  return receiptPage(c, job);
});

/** The waiting room's question (with script): is this application's AI interview ready? Only for the application the grant names. */
const WAIT_STATUS_POLICY: Policy = { name: "apply.wait_status", rules: [{ by: "ip", windowMs: 3_600_000, limit: 1200 }] };

candidatePages.post("/careers/:slug/jobs/:roleId/applied/status", rateLimit(WAIT_STATUS_POLICY), async (c) => {
  const container = c.get("container");
  let raw: unknown = null;
  try { raw = await c.req.json(); } catch { raw = null; }
  const grant = openWaitGrant(container, (raw as { grant?: unknown } | null)?.grant, c.req.param("roleId") ?? "");
  c.header("Cache-Control", "no-store");
  if (!grant) return c.json({ state: "unknown" }, 404);
  const wait = await waitStateOf(container, grant);
  // Never the link itself: the page presses Start my interview, which opens it.
  return c.json({ state: wait.state });
});

/**
 * "Start my interview" (and the script's press once it is ready): opens the AI interview of the application the grant
 * names when it exists, otherwise the waiting room again (or the receipt, saying what happens instead).
 */
candidatePages.post("/careers/:slug/jobs/:roleId/applied/start", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const grant = openWaitGrant(container, body.grant, job.role.id);
  return receiptPage(c, job, grant ? { grant, again: true } : {});
});
