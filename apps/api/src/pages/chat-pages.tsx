/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { SCREEN_PERSON_ROUTE_STATUSES } from "@ros/contracts";
import { WITHDRAW_CONFIRM_KEY } from "@ros/agents";
import { openPayload } from "@ros/core";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { conversationLater, conversationPerson, conversationStart, conversationTurn, conversationView, conversationWithdraw, type ConversationView } from "../services/apply-conversation";
import { CONVERSATION_COOKIE, CONVERSATION_PURPOSE, linkGone, screenPath, type ConversationPayload } from "./candidate-shared";
import { AnswerForms, AsideActions, Bubble, CHAT_BUSY_NOTE, CHAT_CSS, ConversationPage, ErrorNote, Progress, WhereAnswersGo, assistantWords, openConversation, turnActionFrom, turnErrorCode, type Line } from "./conversation-frame";
import { Icon } from "./icons";
import { JOURNEY_CSS, Journey, type JourneyStep } from "./journey";
import { ReviewPage } from "./review-page";
import { PERSON_ON_THE_WEB, forTheWeb } from "./web-wording";

/**
 * The screening chat on the web (plan Wave E; Wave S7, S7-0: moved as it was from pages/candidate.tsx): the
 * introduction, one question at a time, a person instead, finishing later, withdrawing, and the closed pages. "Check
 * your answers" is pages/review-page.tsx. Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as chatPages };

/** The masked address the application's link went to, for the introduction, when this browser just sent the form. */
function appliedTo(c: Context<Vars>, token: string): string | null {
  const container = c.get("container");
  const sealed = openPayload<ConversationPayload>(CONVERSATION_PURPOSE, getCookie(c, CONVERSATION_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  return sealed?.v === 1 && sealed.token === token && typeof sealed.to === "string" ? sealed.to : null;
}

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
  // First view (founder brief, 14 October 2026): the four points and the three ways on. What each way does, how to
  // answer, and the role's own AI wording are one click away.
  return (
    <ConversationPage view={view} title="Before you start" aiMore={disclosure || null} header={view.oneVisit ? <ChatJourney view={view} later={false} /> : null} extraCss={view.oneVisit ? JOURNEY_CSS : undefined}>
      {props.applied ? (
        <div class="card" role="status">
          <strong>Your application is sent.</strong>
          <p>Your own link to it is on its way to {props.applied}. If you applied for this job before, it may be in one of our earlier emails.</p>
        </div>
      ) : null}
      <h1>{intro.title}</h1>
      <p class="lead">{intro.disclosure}</p>
      <ul class="points">
        <li><Icon name="people" /><span>It is a conversation, not a test. There are no trick questions.</span></li>
        <li><Icon name="clock" /><span>About {intro.questions} {intro.questions === 1 ? "question" : "questions"} and {intro.minutes} minutes, one question at a time.</span></li>
        <li><Icon name="check" /><span>You can skip any question, or stop and come back later: this page keeps your place.</span></li>
        <li><Icon name="eye" /><span>It helps the hiring team at {view.companyName} learn about your work. People decide.</span></li>
      </ul>
      {teamLine ? <p class="pre">{teamLine}</p> : null}
      <div class="actions">
        <form method="post" action={`${base}/start`}><button class="btn" type="submit">Start</button></form>
        <form method="post" action={`${base}/later`}><button class="btn secondary" type="submit">Do this later</button></form>
        <a class="btn secondary" href={`${base}/person`}>I'd rather talk to a person</a>
      </div>
      <details class="more">
        <summary>More about this conversation</summary>
        <p>Would you rather talk to a person? {PERSON_ON_THE_WEB}</p>
        <p class="meta">"Do this later" emails you the link. "I'd rather talk to a person" lets you send your application without the conversation, or have a person contact you.</p>
        <p class="meta">Answer in your own words, as briefly as you like. The conversation helps the team learn about your work beyond your resume, and your answers go to them when you press Send my answers at the end.</p>
      </details>
    </ConversationPage>
  );
}

/**
 * WITHDRAW asked first (Wave 0 item 0.7), on the question page and in the chat alike: nothing is withdrawn until the
 * candidate presses the first button; the second keeps the application and picks up where it was.
 */
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
      {view.withdrawPending ? <WithdrawAsk view={view} /> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={base} tap={followUp ? null : q?.tap ?? null} about={followUp ?? heading} submit="Send" skip={!!q} keepsAnswer={!!q?.answered} />
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/**
 * The steps header on the chat's pages (Wave S7, spec step 5): Details · Chat · Review & send in one visit, with the
 * chat's counter once it has a plan ("2 of 4 required · Required questions", founder decision S7-3: never the questions
 * in advance), "Saved" and "Finish later" (the same `/later` as the bottom link; both stay).
 */
function ChatJourney(props: { view: ConversationView; later: boolean }) {
  const steps: JourneyStep[] = props.view.oneVisit ? ["details", "chat", "review"] : ["chat", "review"];
  return <Journey steps={steps} current="chat" counter={props.view.counter} finishLater={props.later ? `${screenPath(props.view.token)}/later` : null} />;
}

/** Where the assistant's latest message is: the one to answer now. */
function latestAssistant(lines: Line[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].role === "assistant") return i;
  return -1;
}

/**
 * The Kanvis-style chat (Wave S7, spec step 6), the chat offered with the application once it has its plan: the steps
 * header with the counter, the chat's title, "where your answers go", the whole chat as a thread (the assistant's
 * latest message, the one to answer, in larger type), then the reply box (Yes and No, the days, a date or a pay range
 * where the question asked is one of the job's factual questions), the quiet skip, a person, and finishing later. While
 * the assistant reads a reply the page says "Reading your reply…" and the box is locked (`SCREEN_BUSY_JS`); without
 * script every form still works.
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
    <ConversationPage view={view} title="Your chat" header={<ChatJourney view={view} later />} extraCss={`${JOURNEY_CSS}${CHAT_CSS}`} busyNote={CHAT_BUSY_NOTE}>
      <h1 class="chat-title">Your chat about the {view.roleTitle} role</h1>
      <WhereAnswersGo companyName={view.companyName} />
      <ol class="thread" aria-label="Your chat">{lines.map((l, i) => <Bubble line={l} open now={i === at} />)}</ol>
      {view.withdrawPending ? <WithdrawAsk view={view} /> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={base} tap={asking ? q?.tap ?? null : null} about={about} submit="Send" skip={!!q} keepsAnswer={!!q?.answered} label="Your reply" />
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/**
 * The chat's end (spec step 6): the close (one concrete thing from the chat, and what happens next) at the end of the
 * thread, and in place of the reply box one bar, "Your chat is complete" with "Review and send", which writes the
 * answers up from the candidate's own replies and shows Review & send (`POST /c/screen/:token/review`). Works without
 * script; while it writes, the page says so.
 */
function ChatEndPage(props: { view: ConversationView }) {
  const { view } = props;
  const base = screenPath(view.token);
  const lines = view.transcript;
  const at = latestAssistant(lines);
  return (
    <ConversationPage view={view} title="Your chat is complete" header={<ChatJourney view={view} later />} extraCss={`${JOURNEY_CSS}${CHAT_CSS}`} busyNote="Writing up your answers from your replies… This can take up to a minute, so please keep this page open.">
      <h1 class="chat-title">Your chat about the {view.roleTitle} role</h1>
      <WhereAnswersGo companyName={view.companyName} />
      <ol class="thread" aria-label="Your chat">{lines.map((l, i) => <Bubble line={l} open now={i === at} />)}</ol>
      <div class="chat-end">
        <p>Your chat is complete.</p>
        <form method="post" action={`${base}/review`}><button class="btn" type="submit">Review and send</button></form>
      </div>
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/** After Send (spec step 8): where the match score and everything sent can be seen, the same for every applicant. */
export const SENT_RECORD_LINE = "Your match score and everything you sent will be on your application page. Its link is in the email we sent you when you applied.";

/** What a closed conversation says, by how it closed (plan E3, E4, E5, A7, A9). Never why a team stopped it. */
function closedWords(view: ConversationView): { title: string; lines: string[] } {
  const co = view.companyName;
  switch (view.status) {
    case "completed":
      // Finished by a recruiter's notes from a call: the candidate's own answers were never sent, so it never says they were.
      if (view.finishedOnACall) return { title: "This conversation is closed", lines: [`Someone working with the hiring team at ${co} went through the questions with you. People on the team make every decision, and you will hear from them either way.`, "Nothing else is needed from you here."] };
      // The same words for a first application and a repeat one: never the application's own link (a repeat's copy must not reveal it).
      return { title: "Thanks, your answers are sent", lines: [`The hiring team at ${co} reads them with your application. People on the team make every decision, and you will hear from them either way.`, SENT_RECORD_LINE, "If anything else is needed from you, we will email you."] };
    case "human_requested": {
      // The time promised when they asked, never a new one each visit. Past it, the page cannot tell whether someone
      // already called (the status stays the same), so it says how to chase it rather than that nobody did.
      const asked = view.personAsked;
      const when = !asked
        ? `Someone working with the hiring team at ${co} will contact you. If nobody has been in touch, reply to any of our emails.`
        : asked.overdue
          ? `Someone working with the hiring team at ${co} was due to contact you by ${asked.dueWords}. If nobody has been in touch yet, reply to any of our emails and we will follow it up.`
          : `Someone working with the hiring team at ${co} aims to contact you by ${asked.dueWords}.`;
      return { title: "A person will be in touch", lines: [when, "Anything you answered here was not sent to the hiring team. Nothing else is needed from you here."] };
    }
    case "declined_by_candidate":
      return { title: "Your application is with the hiring team", lines: [`It went to the hiring team at ${co} without the conversation. People on the team review it, and you will hear from them either way.`] };
    case "paused":
      return { title: "The conversation is paused", lines: [`Sorry, ${co}'s AI assistant has stopped working for the moment. Your answers so far are saved.`, "We will email you a link to finish as soon as it is working again, usually within a few hours."] };
    case "unfinished":
      // Stopped part-way, or answered everything and never pressed Send: the same words, true for both.
      return { title: "This conversation has closed", lines: [`It closed before you sent your answers. Your application has gone to the hiring team at ${co} and carries on; the answers you did not send were not passed on. Nothing else is needed from you.`] };
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
      {/* Lost that email? "Lost your link?" sends it again, only ever to the address the application was made with. */}
      {view.status === "completed" && !view.finishedOnACall ? <p><a class="btn secondary" href="/c/link-request">Email me my link again</a></p> : null}
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
      <p class="lead">That is fine. Anything you have answered so far is not sent to the hiring team.</p>
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
      {/* The heading says the link was emailed; the card says where it went and how long it keeps their place. */}
      <div class="card" role="status">
        <p>It went to the email address on your application. It keeps your place, so open it whenever suits you in the next few days.</p>
      </div>
      <p>Changed your mind? <a href={screenPath(view.token)}>Start now instead</a>.</p>
    </ConversationPage>
  );
}

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
  // A Kanvis-style chat that has ended shows its close and "Review and send" until its answers are written up.
  if (view.phase === "review") return c.html(view.counter && !view.writeup && view.written.length ? <ChatEndPage view={view} /> : <ReviewPage view={view} changed={c.req.query("changed") ?? null} error={error} />);
  if (view.phase === "closed") return c.html(<ClosedPage view={view} />);
  return c.html(view.counter ? <ChatPage view={view} error={error} /> : <QuestionPage view={view} error={error} />);
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
