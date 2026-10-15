/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { eq } from "drizzle-orm";
import { TapAnswer, type TapFormat } from "@ros/contracts";
import { MOVED_ON_MESSAGE, SKIPPED_MESSAGE } from "@ros/agents";
import { applications } from "@ros/db";
import type { Container } from "../container";
import { findConversation, type ConversationRef, type ConversationView, type TurnAction } from "../services/apply-conversation";
import { anonymizedFor } from "./candidate-shared";
import { Icon } from "./icons";
import { Layout, currentNonce } from "./layout";
import { THREAD_CSS } from "./thread";
import { PERSON_BY_EMAIL, PERSON_ON_THE_WEB, forTheWeb } from "./web-wording";

/**
 * The frame every conversation page is drawn in (Wave S7, S7-0: moved as it was from pages/candidate.tsx), shared by the
 * chat (pages/chat-pages.tsx) and Review & send (pages/review-page.tsx): the styles, the AI line, the page around each
 * conversation page and its one script, the progress bar, the answer forms, the quiet actions, the error lines, and
 * reading what a form sent.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The screening conversation (plan Wave E): server-rendered, works without JavaScript, one question at a time.  */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The conversation's own styles, on top of the page stylesheet: the line on top of every page saying it is the
 * company's AI assistant, the question in large type, the assistant's messages on the left in a sunken box and the
 * candidate's own in near-black on the right (shared with the status page's messages, thread.tsx), a thin progress bar (a native progress element, so no inline style), the
 * tap answers, the quiet actions (skip, a person, later), the line shown while an answer is on its way, and the "check
 * your answers" list. Buttons and their secondary look come from the page stylesheet, like every other candidate page.
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
.link-action:disabled { color: var(--ink-3); text-decoration: none; cursor: not-allowed; }
.sending { margin: 16px 0 0; color: var(--ink-2); font-size: 14.5px; }
.sending:empty { margin: 0; }
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
export async function openConversation(container: Container, token: string): Promise<{ ref: ConversationRef; gone: boolean } | null> {
  const ref = await findConversation(container.db, token);
  if (!ref) return null;
  const [app] = await container.db.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, ref.applicationId)).limit(1);
  return { ref, gone: app ? await anonymizedFor(container, app.candidateId) : false };
}

export type Line = ConversationView["transcript"][number];

/**
 * What the assistant said, as this page shows it: a line written for email or text ("Reply HUMAN at any time…") reads
 * as this page's own way to a person (`open`: the "I'd rather talk to a person" button is on the page), or by email once
 * the conversation has closed (polish list). The transcript itself is not changed.
 */
export function assistantWords(content: string, open: boolean): string {
  return forTheWeb(content, open ? PERSON_ON_THE_WEB : PERSON_BY_EMAIL);
}

/**
 * One message: the assistant's on the left, the candidate's own on the right (their answers in their own words, taps
 * and changes included), a skipped question as a quiet note. `now` (the chat, Wave S7): the assistant's latest message,
 * the one to answer, marked for the eye and as the page's `#question`.
 */
export function Bubble(props: { line: Line; open: boolean; now?: boolean }) {
  const { line } = props;
  if (line.role === "system") return <li class="msg system">{line.content === SKIPPED_MESSAGE ? "You skipped this question." : line.content === MOVED_ON_MESSAGE ? "You moved on. Your answer is kept." : assistantWords(line.content, props.open)}</li>;
  if (line.role === "candidate") return <li class="msg candidate"><span class="sr-only">You said: </span>{line.content}</li>;
  if (props.now) return <li class="msg assistant now" id="question"><span class="sr-only">The assistant said: </span>{assistantWords(line.content, props.open)}</li>;
  return <li class="msg assistant"><span class="sr-only">The assistant said: </span>{assistantWords(line.content, props.open)}</li>;
}

/** On top of every conversation page (plan E2): who the candidate is talking to, before anything else. */
function AiLine(props: { companyName: string }) {
  return <p class="ai-line"><span class="ai-tag">AI assistant</span><span>This conversation is with {props.companyName}'s AI assistant, a software program, not a person. People on the hiring team make every decision.</span></p>;
}

/**
 * Every page of the conversation: the AI line, the company and the job, the page, the line that says an answer is on its
 * way (empty until a button is pressed), the AI notice, the privacy link, and the script that stops a second press. The
 * AI line on top already says it is the company's AI assistant, so the notice's full text (and `aiMore`, the role's own
 * AI wording on the introduction) sits one click away under "How AI is used" (founder brief, 14 October 2026).
 *
 * Wave S7 (S7-0, nothing passes them yet): `header` is drawn directly under the AI line, which stays the first thing on
 * the page (the steps header, pages/journey.tsx); `extraCss` is a page's own styles, added to the conversation's in the
 * same style element (the candidate stylesheet's budget is in packages/ui/src/weight-guard.test.ts).
 */
export function ConversationPage(props: { view: ConversationView; title: string; aiMore?: string | null; header?: unknown; extraCss?: string; busyNote?: string | null; children?: unknown }) {
  const { view } = props;
  return (
    <Layout title={`${props.title}: ${view.roleTitle} at ${view.companyName}`} extraCss={props.extraCss ? `${SCREEN_CSS}${props.extraCss}` : SCREEN_CSS}>
      <AiLine companyName={view.companyName} />
      {props.header ? props.header : null}
      <p class="eyebrow">{view.companyName} · {view.roleTitle}</p>
      {props.children}
      {/* `busyNote` (the chat's "Reading your reply…"): what the line says while an answer is on its way. */}
      <p class="sending" id="sending" role="status" data-wait={props.busyNote ?? undefined} />
      {view.intro.aiNotice || props.aiMore ? (
        <details class="more">
          <summary>How AI is used</summary>
          {props.aiMore ? <p class="notice">{props.aiMore}</p> : null}
          {view.intro.aiNotice ? <p class="notice">{view.intro.aiNotice.text}</p> : null}
        </details>
      ) : null}
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
      <script nonce={currentNonce()} dangerouslySetInnerHTML={{ __html: SCREEN_BUSY_JS }} />
    </Layout>
  );
}

/**
 * One press at a time on the conversation's pages. A typed answer waits for the assistant's reply inside the request
 * (often 5 to 20 seconds), so without this the page looks frozen and a second press sends the answer twice. The first
 * submit locks the page: every button is disabled, the pressed one says "Sending…", and the line under the forms says it
 * can take a while; any later submit, from any form on the page, is stopped. The buttons are disabled a moment after the
 * submit, not during it, because a browser leaves a disabled button's own value (Yes, No, Skip) out of what it sends.
 * Coming back to the page with the Back button unlocks it. Plain ES5 with no inline handlers (the policy forbids them);
 * without script the forms still work as before. Wave S7: the chat's reply box is locked too (read-only, so what was
 * typed still goes), and the line says what the page asks for (`data-wait` on it: "Reading your reply…").
 */
export const SCREEN_BUSY_JS = `(function(){
var busy=false;var note=document.getElementById('sending');
var wait=note&&note.getAttribute?note.getAttribute('data-wait'):null;
function lock(pressed){
var all=document.querySelectorAll('main button');
for(var i=0;i<all.length;i++){if(!all[i].disabled){all[i].disabled=true;all[i].setAttribute('data-busy','');}}
var boxes=document.querySelectorAll('main textarea');
for(var j=0;j<boxes.length;j++){if(!boxes[j].readOnly){boxes[j].readOnly=true;boxes[j].setAttribute('data-busy','');}}
if(pressed){pressed.setAttribute('data-label',pressed.textContent);pressed.textContent='Sending…';}
if(note){note.textContent=wait||'Sending… This can take up to a minute, so please keep this page open.';}
}
function unlock(){
var all=document.querySelectorAll('main button[data-busy]');
for(var i=0;i<all.length;i++){var b=all[i];b.disabled=false;b.removeAttribute('data-busy');if(b.hasAttribute('data-label')){b.textContent=b.getAttribute('data-label');b.removeAttribute('data-label');}}
var boxes=document.querySelectorAll('main textarea[data-busy]');
for(var j=0;j<boxes.length;j++){boxes[j].readOnly=false;boxes[j].removeAttribute('data-busy');}
if(note){note.textContent='';}
busy=false;
}
document.addEventListener('submit',function(ev){
if(busy){ev.preventDefault();return;}
busy=true;var pressed=ev.submitter||null;
window.setTimeout(function(){if(ev.defaultPrevented){busy=false;return;}lock(pressed);},0);
},true);
window.addEventListener('pageshow',function(ev){if(ev.persisted){unlock();}});
})();`;

/* ------------------------------------------------------------------------------------------------------------ */
/* The Kanvis-style chat (Wave S7, spec step 6)                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the line under the forms says while the assistant reads a reply in the chat; the reply box is locked meanwhile. */
export const CHAT_BUSY_NOTE = "Reading your reply… This can take up to a minute, so please keep this page open.";

/**
 * The chat's own styles, passed as a page's `extraCss` (never into the candidate stylesheet, whose budget is spent):
 * tokens only, no button rules, no motion. The "where your answers go" line, the chat's title, the latest message in
 * a slightly larger type (the question to answer now), and the bar at the chat's end.
 */
export const CHAT_CSS = `
.where-go { display: flex; align-items: flex-start; gap: 8px; margin: 0 0 14px; color: var(--ink-2); font-size: 14.5px; line-height: 1.45; }
.where-go .icon { flex: none; margin-top: 2px; }
h1.chat-title { margin: 6px 0 4px; font-size: 24px; line-height: 1.25; }
.thread .msg.assistant.now { font-size: 17px; }
.chat-end { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 22px 0 0; padding: 14px 18px; border: 1px solid var(--line-2); border-radius: var(--r-card); background: var(--surface-2); }
.chat-end p { margin: 0; color: var(--ink); font-weight: 600; }
`;

/**
 * "Where your answers go" (spec step 6), on every page of the chat: said plainly, true to the 9 October 2026 decision
 * ("hide them until they send"): the team sees nothing of the chat before Send.
 */
export function WhereAnswersGo(props: { companyName: string }) {
  // Each reply's own button sends it to the assistant only: the line names the button at the end that sends them on.
  return <p class="where-go"><Icon name="eye" /><span>Your replies go to {props.companyName} only when you press Send my answers at the end.</span></p>;
}

/** "Question 2 of 5" over a thin bar. */
export function Progress(props: { at: number; total: number; text: string }) {
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
function TypedAnswer(props: { action: string; about: string; submit: string; skip: boolean; keepsAnswer?: boolean; autofocus?: boolean; value?: string; label?: string }) {
  return (
    <form method="post" action={props.action}>
      <label for="message">{props.label ?? "Your answer"}<span class="sr-only"> to: {props.about}</span></label>
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
        <fieldset class="actions" aria-label={`Your answer to: ${props.about}`}>
          <button class="btn secondary" type="submit" name="choice" value="yes">Yes</button>
          <button class="btn secondary" type="submit" name="choice" value="no">No</button>
          {skip}
        </fieldset>
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

/** A tap answer where the question takes one, with the candidate's own words one click away; otherwise the words. `label`: the box's name ("Your reply" in the chat). */
export function AnswerForms(props: { action: string; tap: TapFormat | null; about: string; submit: string; skip: boolean; keepsAnswer?: boolean; value?: string; label?: string }) {
  if (!props.tap) return <TypedAnswer action={props.action} about={props.about} submit={props.submit} skip={props.skip} keepsAnswer={props.keepsAnswer} autofocus value={props.value} label={props.label} />;
  return (
    <>
      <TapAnswerForm action={props.action} tap={props.tap} about={props.about} submit={props.submit} skip={props.skip} />
      <details class="own-words">
        <summary>Answer in your own words instead</summary>
        <TypedAnswer action={props.action} about={props.about} submit={props.submit} skip={false} value={props.value} label={props.label} />
      </details>
    </>
  );
}

/** Always there, and quiet: a person instead (E3), and the link by email to finish later (E2, E4). */
export function AsideActions(props: { base: string; later: boolean }) {
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

export function turnErrorCode(message: string): string {
  if (/type an answer/i.test(message)) return "empty";
  if (/does not fit/i.test(message)) return "tap";
  if (/no question to answer/i.test(message)) return "stale";
  return "trouble";
}

export function ErrorNote(props: { code?: string | null }) {
  const text = props.code ? TURN_ERRORS[props.code] : undefined;
  return text ? <div class="err" role="alert">{text}</div> : null;
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
export function turnActionFrom(body: FormBody): TurnAction | null {
  if (field(body, "action") === "skip") return { skip: true };
  const kind = field(body, "tap");
  if (kind) {
    const tap = tapFrom(body, kind);
    return tap ? { tap } : null;
  }
  return { message: field(body, "message") };
}

/** A question's key in an address: the packet's own keys are short snake_case. */
export const ANSWER_KEY = /^[A-Za-z0-9_-]{1,100}$/;
