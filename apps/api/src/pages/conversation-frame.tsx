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
import { FOOT_CSS } from "./signin-link";
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
 * The conversation's own styles, on top of the page stylesheet (October 2026 redesign, the guided chat of the reference
 * screens): the line on top of every page saying it is the company's AI assistant, as a soft lavender note with its tag;
 * the introduction's points as rows with an icon chip; the question in large type; the assistant's messages on the left
 * in white bubbles and the candidate's own in peach on the right (shared with the status page's messages, thread.tsx); a
 * thin progress bar that runs from plum to coral (a native progress element, so no inline style); the tap answers as
 * tiles; the reply box drawn as one field with its Send button (`form.reply`); the quiet actions (skip, a person,
 * later) as plain text links; the line shown while an answer is on its way; the two equal choices; and "check your
 * answers" as the rows of one list with a pill for each mark. Buttons and their secondary look come from the page
 * stylesheet, like every other candidate page; tokens only.
 */
export const SCREEN_CSS = `
.ai-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--tint-2); border-radius: 14px; background: var(--tint); color: var(--ink-2); font-size: 14px; line-height: 1.5; }
.ai-tag { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 8px; border: 1px solid var(--tint-2); border-radius: var(--r-pill); background: var(--surface); color: var(--primary); font-size: 12px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.ai-tag::before { content: ""; flex: none; width: 10px; height: 10px; background: var(--accent); clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); }
h1.question { margin: 14px 0 18px; font-size: 28px; line-height: 1.2; letter-spacing: -0.025em; }
.lead-in { margin: 20px 0 0; color: var(--ink-2); }
${THREAD_CSS}
.points { display: grid; gap: 0; margin: 22px 0; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); list-style: none; }
.points li { display: flex; align-items: center; gap: 14px; margin: 0; padding: 12px 18px 12px 14px; color: var(--ink); font-size: 15px; line-height: 1.45; }
.points li + li { border-top: 1px solid var(--line); }
.points .icon { flex: none; box-sizing: content-box; width: 18px; height: 18px; margin: 0; padding: 9px; border-radius: 12px; background: var(--tint-2); color: var(--primary); }
.points li > span { min-width: 0; padding-top: 0; overflow-wrap: anywhere; }
.progress { display: flex; align-items: center; gap: 14px; margin: 0 0 8px; color: var(--ink-2); font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.progress label { flex: none; margin: 0; color: inherit; font-size: inherit; font-weight: inherit; }
.progress progress { flex: 1; min-width: 0; height: 6px; overflow: hidden; border: 0; border-radius: var(--r-pill); background: var(--line); color: var(--primary); -webkit-appearance: none; appearance: none; }
.progress progress::-webkit-progress-bar { border-radius: var(--r-pill); background: var(--line); }
.progress progress::-webkit-progress-value { border-radius: 9999px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
.progress progress::-moz-progress-bar { border-radius: 9999px; background: linear-gradient(90deg, var(--primary), var(--accent)); }
details.earlier, details.own-words { margin: 20px 0 0; }
details.earlier > summary, details.own-words > summary { padding: 9px 0; color: var(--ink-2); font-size: 14.5px; font-weight: 600; cursor: pointer; }
.days { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr)); gap: 8px; margin-top: 10px; }
.days .slot { display: flex; align-items: center; gap: 10px; min-height: 48px; margin: 0; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); color: var(--ink); font-size: 15px; font-weight: 600; line-height: 1.3; cursor: pointer; }
.days .slot:has(input:checked) { border-color: var(--primary); background: var(--tint); box-shadow: inset 0 0 0 1px var(--primary); }
.days .slot input { flex: none; margin: 0; }
.pay-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 12px; }
.reply { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0 14px; margin: 20px 0 0; padding: 12px 12px 12px 18px; border: 1px solid var(--line-strong); border-radius: var(--r-panel); background: var(--surface); }
.reply:focus-within { border-color: var(--primary); }
.reply:has(> textarea:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.reply > label { grid-column: 1 / -1; margin: 0 0 2px; color: var(--ink-2); font-size: 13px; font-weight: 600; }
.reply > textarea { grid-column: 1 / -1; width: 100%; min-height: 88px; margin: 0; padding: 4px 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; resize: vertical; }
.reply > textarea:focus, .reply > textarea:focus-visible { outline: 2px solid transparent; outline-offset: 0; }
.reply > .actions { grid-column: 2; justify-content: flex-end; margin: 8px 0 0; }
.reply > .actions > :first-child { min-width: 0; }
.link-action { display: inline-flex; align-items: center; min-height: 44px; padding: 0; border: 0; background: none; color: var(--ink-2); font: inherit; font-size: 14.5px; font-weight: 600; line-height: 1.3; text-decoration: underline; text-decoration-thickness: 1px; text-decoration-color: var(--line-strong); text-underline-offset: 4px; cursor: pointer; }
.link-action:disabled { color: var(--ink-3); text-decoration: none; cursor: not-allowed; }
.sending { margin: 16px 0 0; color: var(--ink-2); font-size: 14px; }
.sending:empty { margin: 0; }
.aside-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0 24px; margin-top: 28px; padding-top: 8px; border-top: 1px solid var(--line); }
.aside-actions > form { display: contents; }
.paths { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 14px; margin: 22px 0; }
.paths > section.card { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 22px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); }
.paths > .card > h2 { margin: 0; font-size: 19px; line-height: 1.25; letter-spacing: -0.02em; }
.paths > .card > p { margin: 0; }
.paths > .card > form { margin-top: auto; padding-top: 10px; }
.answers { margin: 20px 0; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); list-style: none; }
.answer { padding: 16px 18px; }
.answer + .answer { border-top: 1px solid var(--line); }
.answer:target { background: var(--tint); }
.answer-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; }
.answer-q { margin: 0; color: var(--ink); font-size: 15px; font-weight: 600; line-height: 1.4; }
.answer > p { margin: 6px 0 0; color: var(--ink-2); font-size: 14.5px; }
.answer > a { display: inline-flex; align-items: center; min-height: 40px; color: var(--primary); font-size: 14px; font-weight: 600; }
.answer .pill { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 10px; border: 0; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-ink); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
${FOOT_CSS}
@media (hover: hover) and (pointer: fine) {
  .link-action:hover { color: var(--primary); text-decoration-color: currentColor; }
  .days .slot:hover { border-color: var(--line-strong); }
}
@media (max-width: 600px) {
  h1.question { font-size: 24px; }
  .reply { grid-template-columns: minmax(0, 1fr); padding: 12px 12px 12px 14px; }
  .reply > .actions { grid-column: 1; justify-content: flex-start; }
}
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
 * Every page of the conversation: the AI line, the page, the line that says an answer is on its way (empty until a
 * button is pressed), the AI notice, the privacy link, and the script that stops a second press. The AI line on top
 * already says it is the company's AI assistant, so the notice's full text (and `aiMore`, the role's own AI wording on
 * the introduction) sits one click away under "How AI is used" (founder brief, 14 October 2026). No "Company · Job"
 * eyebrow (fewer words, 23 October 2026): the AI line names the company, and the browser tab names the job.
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
 * tokens only, no button rules. The "where your answers go" line with its icon chip, the chat's title, the whole chat
 * in one soft panel (the guided conversation of the reference screens: lavender at the top, a touch of peach at the
 * foot), the latest message slightly larger and lifted (the question to answer now), and the bar at the chat's end as
 * the "your next step" card with its coral dot. The one motion on the page: the newest message fades in and rises 8px
 * once, in 200ms, only when motion is welcome (and the candidate stylesheet stops every animation for reduced motion).
 */
export const CHAT_CSS = `
.where-go { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; color: var(--ink-2); font-size: 14px; line-height: 1.45; }
.where-go .icon { flex: none; box-sizing: content-box; width: 16px; height: 16px; padding: 6px; border-radius: 9px; background: var(--tint-2); color: var(--primary); }
h1.chat-title { margin: 6px 0 8px; font-size: 26px; line-height: 1.2; letter-spacing: -0.025em; }
.thread[aria-label="Your chat"] { margin: 18px 0 20px; padding: 20px 18px; border: 1px solid var(--line); border-radius: var(--r-panel); background: linear-gradient(165deg, var(--tint) 0%, var(--surface) 46%, var(--surface) 72%, var(--peach) 140%); }
.thread .msg.assistant.now { border-color: var(--line-2); font-size: 16.5px; box-shadow: var(--sh-pop); }
.chat-end { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 20px; margin: 24px 0 0; padding: 24px; border: 1px solid var(--tint-2); border-radius: var(--r-panel); background: linear-gradient(115deg, var(--tint) 0%, var(--surface) 58%, var(--peach) 135%); }
.chat-end p { display: flex; align-items: center; gap: 12px; margin: 0; color: var(--ink); font-family: var(--display); font-size: 22px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
.chat-end p::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.chat-end form { margin: 0; }
@keyframes msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: no-preference) {
  .thread .msg.now { animation: msg-in 200ms cubic-bezier(0.22, 1, 0.36, 1) 60ms both; }
}
@media (max-width: 600px) {
  .thread[aria-label="Your chat"] { padding: 14px 12px; border-radius: var(--r-card); }
  .chat-end { padding: 20px 18px; }
  .chat-end p { font-size: 20px; }
}
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
  // `reply`: drawn as one field holding the words and the Send button (SCREEN_CSS).
  return (
    <form method="post" action={props.action} class="reply">
      <label for="message">{props.label ?? "Your answer"}<span class="sr-only"> to: {props.about}</span></label>
      <textarea id="message" name="message" rows={4} maxlength={2000} required autofocus={props.autofocus}>{props.value ?? ""}</textarea>
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
