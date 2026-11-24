/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { SCREEN_ACTIVE_STATUSES } from "@ros/contracts";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { conversationPerson, conversationStart, conversationTurn, conversationView, conversationWithdraw, type ConversationView } from "../services/screens";
import { linkGone, screenPath } from "./candidate-shared";
import { AnswerForms, AsideActions, Bubble, CHAT_BUSY_NOTE, CHAT_CSS, ConversationPage, ErrorNote, WhereAnswersGo, assistantWords, openConversation, turnActionFrom, turnErrorCode, type Line } from "./conversation-frame";
import { Icon } from "./icons";
import { ReviewPage } from "./review-page";
import { PERSON_ON_THE_WEB } from "./web-wording";

/**
 * The AI interview on the web: the introduction, the chat, a person instead, withdrawing, and the closed pages. "Check
 * your answers" is pages/review-page.tsx. Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as chatPages };

/**
 * The fixed introduction, before the first question: it is the company's AI assistant, not a person; what it is for; a
 * conversation, not a test; how long; skip, stop and come back; how to reach a person; then Start, or I'd rather talk to
 * a person. Every sentence is this page's own, the code's line about reaching a person, or the versioned AI notice
 * (`screenIntro`). Of the job record the page shows the title and the length in minutes, which the company sees and
 * can edit, and never the record's own lines about AI and about a person, which a model wrote and nobody was shown. No
 * sentence here is written by a model. Start shows the first question at once.
 */
function IntroPage(props: { view: ConversationView }) {
  const { view } = props;
  const { intro } = view;
  const base = screenPath(view.token);
  return (
    <ConversationPage view={view} title="Before you start">
      <h1>{intro.title}</h1>
      <p class="lead">{intro.disclosure}</p>
      <ul class="points">
        <li><Icon name="people" /><span>It is a conversation, not a test. There are no trick questions.</span></li>
        <li><Icon name="clock" /><span>About {intro.minutes} minutes, one question at a time.</span></li>
        <li><Icon name="check" /><span>You can skip any question, or stop and come back later: this page keeps your place.</span></li>
        <li><Icon name="eye" /><span>It helps the hiring team at {view.companyName} learn about your work. People decide.</span></li>
      </ul>
      <p class="pre">{intro.humanAlternative}</p>
      <div class="actions">
        <form method="post" action={`${base}/start`}><button class="btn" type="submit">Start</button></form>
        <a class="btn secondary" href={`${base}/person`}>I'd rather talk to a person</a>
      </div>
      <details class="more">
        <summary>More about this conversation</summary>
        <p>Would you rather talk to a person? {PERSON_ON_THE_WEB}</p>
        <p class="meta">Answer in your own words, as briefly as you like. The conversation helps the team learn about your work beyond your resume, and your answers go to them when you press Send my answers at the end.</p>
      </details>
    </ConversationPage>
  );
}

/** WITHDRAW asked first: nothing is withdrawn until the candidate presses the first button; the second keeps the application and picks up where it was. */
function WithdrawAsk(props: { view: ConversationView }) {
  return (
    <div class="card" role="status">
      <strong>Do you want to withdraw your application?</strong>
      <p>Withdrawing ends this conversation and your application for {props.view.roleTitle}.</p>
      <form method="post" action={`${screenPath(props.view.token)}/withdraw`} class="actions">
        <button class="btn" type="submit" name="confirm" value="yes">Yes, withdraw my application</button>
        <button class="btn secondary" type="submit" name="confirm" value="no">No, keep my application</button>
      </form>
    </div>
  );
}

/** Where the assistant's latest message is: the one to answer now. */
function latestAssistant(lines: Line[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].role === "assistant") return i;
  return -1;
}

/**
 * The chat: its title, how far along it is ("Question 2 of 6"; never the questions in advance), "where your answers
 * go", the whole chat as a thread (the assistant's latest message, the one to answer, in larger type), then the reply
 * box (Yes and No, a date or a pay range where the question asked takes one), the quiet skip, and a person. While the
 * assistant reads a reply the page says "Reading your reply…" and the box is locked (`SCREEN_BUSY_JS`); without script
 * every form still works.
 */
function ChatPage(props: { view: ConversationView; error?: string | null }) {
  const { view } = props;
  const base = screenPath(view.token);
  const q = view.current;
  const lines = view.transcript;
  const at = latestAssistant(lines);
  const last = at >= 0 ? lines[at] : null;
  // The question itself (not a follow-up on it): a tap answer where it takes one.
  const asking = !!q && last?.questionKey === q.key && !view.withdrawPending;
  // The reply box is named after what it answers: the question itself, or the follow-up on it.
  const about = asking && q && last?.content.includes(q.question) ? q.question : last ? assistantWords(last.content, true) : q?.question ?? "the chat";
  return (
    <ConversationPage view={view} title="Your chat" extraCss={CHAT_CSS} busyNote={CHAT_BUSY_NOTE}>
      <h1 class="chat-title">Your chat about the {view.roleTitle} role</h1>
      {view.counter ? <p class="meta">{view.counter.label}</p> : null}
      <WhereAnswersGo companyName={view.companyName} />
      <ol class="thread" aria-label="Your chat">{lines.map((l, i) => <Bubble line={l} open now={i === at} />)}</ol>
      {view.withdrawPending ? <WithdrawAsk view={view} /> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={base} tap={asking ? q?.tap ?? null : null} about={about} submit="Send" skip={!!q} keepsAnswer={!!q?.answered} label="Your reply" />
      <AsideActions base={base} />
    </ConversationPage>
  );
}

/** What a closed AI interview says, by how it closed. Never why a team stopped it. */
function closedWords(view: ConversationView): { title: string; lines: string[] } {
  const co = view.companyName;
  switch (view.status) {
    case "completed":
      return { title: "Thanks, your answers are sent", lines: [`The hiring team at ${co} reads them with your application. People on the team make every decision.`, "Everything you sent is on your status page. Its link is in the email we sent you when you applied.", "Nothing more is needed from you here."] };
    case "declined_by_candidate":
      return { title: "The hiring team has been told", lines: [`The hiring team at ${co} has been told you would rather talk to a person than do the AI interview. They decide the next step.`, "Anything you answered here was not sent to the hiring team. Nothing else is needed from you here."] };
    case "expired":
      return { title: "This link has closed", lines: [`The link to this AI interview has closed. The answers you did not send were not passed on. If you would still like to do it, reply to any of our emails: the hiring team at ${co} can send you a new link.`] };
    default:
      // Cancelled by the team, or closed with the application: nothing about why.
      return { title: "This AI interview is closed", lines: ["Nothing more is needed from you here. If you have a question, reply to any of our emails."] };
  }
}

function ClosedPage(props: { view: ConversationView }) {
  const { view } = props;
  const words = closedWords(view);
  return (
    <ConversationPage view={view} title={words.title}>
      <h1>{words.title}</h1>
      <div class="card" role="status">{words.lines.map((l) => <p>{l}</p>)}</div>
      {/* Lost that email? "Lost your link?" sends it again, only ever to the address the application was made with. */}
      {view.status === "completed" ? <p><a class="btn secondary" href="/c/link-request">Email me my link again</a></p> : null}
      {view.status === "completed" && view.transcript.length ? (
        <details class="earlier">
          <summary>See the conversation</summary>
          <ol class="thread" aria-label="The questions and your answers">{view.transcript.map((l) => <Bubble line={l} open={false} />)}</ol>
        </details>
      ) : null}
    </ConversationPage>
  );
}

/** "I'd rather talk to a person": one choice, said plainly, and that it is fine. */
function PersonPage(props: { view: ConversationView }) {
  const { view } = props;
  const base = screenPath(view.token);
  return (
    <ConversationPage view={view} title="Talk to a person instead">
      <p class="back"><a href={base}><Icon name="arrow-left" />Back to the conversation</a></p>
      <h1>Talk to a person instead</h1>
      <p class="lead">That is fine. Anything you have answered so far is not sent to the hiring team.</p>
      <section class="card" aria-labelledby="path-person">
        <h2 id="path-person">Tell the hiring team</h2>
        <p>The hiring team at {view.companyName} is told you would rather talk to a person than do the AI interview. Your application stays with them, and they decide the next step. This AI interview then closes.</p>
        <form method="post" action={`${base}/person`}>
          <button class="btn secondary" type="submit">Tell the hiring team</button>
        </form>
      </section>
    </ConversationPage>
  );
}

/**
 * The AI interview's page. Opening the link writes nothing (a mail scanner may open it): the introduction is fixed, and
 * Start shows the first question. Once every question is done the same address shows "Check your answers".
 */
candidatePages.get("/c/screen/:token", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  c.header("Cache-Control", "no-store");
  const error = c.req.query("error") ?? null;
  if (view.phase === "intro") return c.html(<IntroPage view={view} />);
  if (view.phase === "review") return c.html(<ReviewPage view={view} changed={c.req.query("changed") ?? null} error={error} />);
  if (view.phase === "closed") return c.html(<ClosedPage view={view} />);
  return c.html(<ChatPage view={view} error={error} />);
});

/** An answer: typed, tapped or skipped. Skips and taps never reach the model. */
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

/** "Start" on the introduction: the first question, in the job's words, at once. Pressing twice changes nothing. */
candidatePages.post("/c/screen/:token/start", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await conversationStart(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});

/** "I'd rather talk to a person": the page that says what choosing it does. Open while the AI interview can still be answered. */
candidatePages.get("/c/screen/:token/person", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  if (!SCREEN_ACTIVE_STATUSES.includes(view.status)) return c.redirect(screenPath(view.token));
  c.header("Cache-Control", "no-store");
  return c.html(<PersonPage view={view} />);
});

/** The choice: the candidate chose not to do the AI interview, and the hiring team is told. The page then says so. */
candidatePages.post("/c/screen/:token/person", rateLimit(POLICIES.screenHuman), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await conversationPerson(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});

/**
 * The answer to "do you want to withdraw?": `confirm=yes` withdraws the application and closes the AI interview,
 * `confirm=no` keeps it and picks up where it was. The link itself is the proof, as on the status page; an AI interview
 * that already ended is left as it is.
 */
candidatePages.post("/c/screen/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.confirm === "yes" || body.confirm === "no") await conversationWithdraw(container, found.ref, body.confirm === "yes");
  return c.redirect(screenPath(found.ref.token));
});
