/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import type { ReviewItem, TapFormat, WriteupAnswer } from "@ros/contracts";
import { writeupCounts } from "@ros/agents";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { conversationEdit, conversationSubmit, conversationView, type ConversationView } from "../services/apply-conversation";
import { learnFromSentChat } from "../services/profile-facts";
import { editWrittenAnswer, ensureWriteup } from "../services/writeup";
import { CORRECTION_LINE, linkGone, screenPath } from "./candidate-shared";
import { ANSWER_KEY, AnswerForms, AsideActions, Bubble, ConversationPage, ErrorNote, Progress, openConversation, turnActionFrom, turnErrorCode } from "./conversation-frame";
import { Icon } from "./icons";
import { JOURNEY_CSS, Journey, type JourneyStep } from "./journey";

/**
 * "Check your answers" and sending them (plan E10), and Review & send (Wave S7, slice S7-D; contract in scratchpad
 * kanvis-2/s7-contracts.md). The conversation's own page (pages/chat-pages.tsx) shows `ReviewPage` once the chat is over.
 * A chat with a write-up (one answer per written question in the candidate's own words, services/writeup.ts) shows
 * Review & send: "Check what you're sending", their details, then "From your chat" with each answer, its Edit link and,
 * kept apart, any "Note from the assistant". A chat without one shows "Check your answers" as before, every answer with
 * its Change link; a chat of the new kind there also offers "Review and send", which writes it up. Both send the same
 * way, and nothing reaches the team before Send. Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as reviewPages };

/** The steps header on these pages (pages/journey.tsx): all three steps in one visit, the chat and this one otherwise. */
function JourneyHeader(props: { view: ConversationView }) {
  const steps: JourneyStep[] = props.view.oneVisit ? ["details", "chat", "review"] : ["chat", "review"];
  return <Journey steps={steps} current="review" finishLater={`${screenPath(props.view.token)}/later`} />;
}

/**
 * Review & send's own styles, passed as the page's own (`extraCss`, never the candidate stylesheet, whose budget is
 * nearly spent): the two sections, the form's answers as one soft card, the assistant's note set apart from the answer
 * (a lavender block with a plum rule and a small mono label, the way evidence is quoted in the team's app), the count,
 * and the bar that leads from "Check your answers" to the write-up as the "your next step" card with its coral dot.
 * Shared tokens only, no motion.
 */
export const REVIEW_SEND_CSS = `
.send-part { margin: 32px 0 0; }
.send-part > h2 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }
.send-part > p { color: var(--ink-2); }
.send-part > h3 { margin: 24px 0 0; font-size: 17px; }
.send-part > ul { margin: 12px 0; padding: 12px 18px 12px 34px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink); font-size: 14.5px; }
.send-part > ul > li + li { margin-top: 4px; }
.assistant-note { margin: 10px 0 0; padding: 10px 14px; border-left: 2px solid var(--primary); border-radius: 0 12px 12px 0; background: var(--tint); color: var(--ink-2); font-size: 14px; }
.assistant-note > p { margin: 0; color: inherit; }
.assistant-note > .note-label { margin: 0 0 4px; color: var(--ink-2); font-family: var(--mono); font-size: 11px; font-weight: 400; letter-spacing: 0.14em; line-height: 1.4; text-transform: uppercase; }
.send-count { margin: 24px 0 10px; color: var(--ink-2); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.review-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 20px; margin: 20px 0; padding: 24px; border: 1px solid var(--tint-2); border-radius: var(--r-panel); background: linear-gradient(115deg, var(--tint) 0%, var(--surface) 58%, var(--peach) 135%); }
.review-bar > p { flex: 1 1 320px; margin: 0; color: var(--ink-2); }
.review-bar > p > strong { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; color: var(--ink); font-family: var(--display); font-size: 22px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
.review-bar > p > strong::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.review-bar > form { margin: 0; }
@media (max-width: 600px) {
  .review-bar { padding: 20px 18px; }
  .review-bar > p { flex-basis: 100%; }
  .review-bar > p > strong { font-size: 20px; }
}
`;

const PAGE_CSS = `${JOURNEY_CSS}${REVIEW_SEND_CSS}`;

/** Both halves stay true and in the page (founder brief, 14 October 2026): nothing goes before Send, and what happens without Send is one click away. */
function WithoutSend() {
  return (
    <details class="more">
      <summary>What if I don't press Send?</summary>
      <p>If you do not press Send, the conversation closes a few days after your last answer or change, and your application goes to the hiring team without these answers. If we have not reminded you yet, we email you once before then.</p>
    </details>
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
 * The assistant's note, set apart from the answer and labelled in visible words. A plain block, never a landmark: a
 * named `aside` inside the page's main area would be a nested landmark, several of them with one name (axe
 * landmark-complementary-is-top-level, landmark-unique).
 */
function AssistantNote(props: { note: string }) {
  return (
    <div class="assistant-note">
      <p class="note-label">Note from the assistant</p>
      <p>{props.note}</p>
    </div>
  );
}

/**
 * One written-up answer on Review & send: the question, the answer in the candidate's words (or that there is none),
 * marked when they changed it, skipped it, or it is missing or partial; the assistant's note under it, labelled as the
 * assistant's and never part of the answer; and its Edit link.
 */
function WrittenItem(props: { answer: WriteupAnswer; question: string; n: number; base: string }) {
  const { answer: a } = props;
  const empty = !a.answer.trim();
  const mark = a.by === "candidate" ? "Changed" : a.status === "skipped" ? "Skipped" : a.status === "not_given" ? "Not answered" : a.status === "partly" ? "Partly answered" : null;
  return (
    <li class="answer" id={`w-${a.questionKey}`}>
      <div class="answer-head">
        <p class="answer-q">{props.n}. {props.question}</p>
        {mark ? <span class="pill">{mark}</span> : null}
      </div>
      <p class="pre">{empty ? (a.status === "skipped" ? "You skipped this question." : "No answer yet.") : a.answer}</p>
      {a.note ? <AssistantNote note={a.note} /> : null}
      <a href={`${props.base}/answers/${encodeURIComponent(a.questionKey)}`}>{empty ? "Answer it" : "Edit"}<span class="sr-only"> (question {props.n})</span></a>
    </li>
  );
}

/**
 * Review & send (spec step 7): "Check what you're sending", the candidate's details for the company, then "From your
 * chat", one answer per written question written up from their own replies, each with Edit and any note from the
 * assistant kept apart; answers to other questions of the chat after them with Change; "N of M answered" and Send.
 *
 * The details are said, not listed, and the form's answers are listed as the chat read them (`formAnswers`): this page
 * reads only the conversation, the same for a first application and a repeat one (Q14 x Q15). Both hold what that visit
 * typed (`typedFacts`) and nothing on file, so the page never tells a stranger whether the address had applied before.
 * The whole chat is one click away.
 */
function SendPage(props: { view: ConversationView; writeup: NonNullable<ConversationView["writeup"]>; changed: string | null; error?: string | null }) {
  const { view, writeup } = props;
  const base = screenPath(view.token);
  const asked = new Map(view.written.map((q) => [q.key, q.question]));
  const review = view.review ?? [];
  const writtenKeys = new Set(writeup.answers.map((a) => a.questionKey));
  const others = review.filter((i) => !writtenKeys.has(i.key));
  const counts = writeupCounts(writeup);
  const answered = counts.answered + others.filter((i) => i.answer !== null).length;
  const total = counts.total + others.length;
  const changed = props.changed && (writtenKeys.has(props.changed) || others.some((i) => i.key === props.changed));
  return (
    <ConversationPage view={view} title="Check what you're sending" header={<JourneyHeader view={view} />} extraCss={PAGE_CSS}>
      <h1>Check what you're sending</h1>
      <p class="lead">{view.companyName} reads this exactly as written, so change anything now. The hiring team sees your answers only once you send them.</p>
      <WithoutSend />
      {changed ? <div class="card" role="status"><strong>Your answer is changed.</strong></div> : null}
      <ErrorNote code={props.error} />
      <section class="send-part" aria-labelledby="send-details">
        <h2 id="send-details">Your details for {view.companyName}</h2>
        {/* What the chat read from the form, the same way for a first application and a repeat one (`formAnswers`). */}
        {view.formAnswers.length ? <ul>{view.formAnswers.map((s) => <li>{s}</li>)}</ul> : null}
        <p>These went with your form, with your name, contact details and resume; this chat does not change them. {CORRECTION_LINE}</p>
      </section>
      <section class="send-part" aria-labelledby="send-chat">
        <h2 id="send-chat">From your chat</h2>
        <p>Written up from your own replies. Change anything that came out wrong.</p>
        <ol class="answers">{writeup.answers.map((a, i) => <WrittenItem answer={a} question={asked.get(a.questionKey) ?? review.find((r) => r.key === a.questionKey)?.question ?? a.questionKey} n={i + 1} base={base} />)}</ol>
        {others.length ? (
          <>
            <h3>Your other answers</h3>
            <ol class="answers">{others.map((item, i) => <AnswerItem item={item} n={writeup.answers.length + i + 1} base={base} />)}</ol>
          </>
        ) : null}
        {view.transcript.length ? (
          <details class="more">
            <summary>See your whole chat</summary>
            <ol class="thread" aria-label="Your whole chat">{view.transcript.map((l) => <Bubble line={l} open={false} />)}</ol>
          </details>
        ) : null}
      </section>
      <p class="send-count">{answered} of {total} answered</p>
      <form method="post" action={`${base}/submit`}>
        <button class="btn" type="submit">Send my answers</button>
      </form>
      <AsideActions base={base} later />
    </ConversationPage>
  );
}

/**
 * What the chat's GET shows once the chat is over (phase "review"). With a write-up: Review & send (`SendPage`).
 * Without one, "Check your answers" (E10): every answer with its Change link, changed and skipped ones marked, then
 * Send; a chat of the new kind (it has a plan and written questions) also offers "Review and send", which writes the
 * answers up. The team sees the answers only once the candidate sends them (founder decision of 9 October 2026, "hide
 * them until they send"), and nothing sends them for the candidate: someone who does not press Send has the
 * conversation closed and the application goes on without the answers (the screen workflow's idle_remind and
 * close_unfinished: one reminder unless they already had one, then two days), and the page says so. Keep it in step
 * with sendConversationReviewReminder and counsel register item 20.
 */
export function ReviewPage(props: { view: ConversationView; changed: string | null; error?: string | null }) {
  const { view } = props;
  if (view.writeup) return <SendPage view={view} writeup={view.writeup} changed={props.changed} error={props.error} />;
  const base = screenPath(view.token);
  const items = view.review ?? [];
  return (
    <ConversationPage view={view} title="Check your answers" header={<JourneyHeader view={view} />} extraCss={PAGE_CSS}>
      <Progress at={view.total} total={view.total} text={`All ${view.total} questions done`} />
      <h1>Check your answers</h1>
      <p class="lead">The hiring team sees your answers only once you send them. Change any answer you like, then press Send.</p>
      <WithoutSend />
      {view.counter && view.written.length ? (
        <div class="review-bar">
          <p><strong>Your chat is complete.</strong> Next, check your answers to {view.companyName}'s questions, written up from your replies.</p>
          <form method="post" action={`${base}/review`}>
            <button class="btn" type="submit">Review and send</button>
          </form>
        </div>
      ) : null}
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
    <ConversationPage view={view} title="Change your answer" header={<JourneyHeader view={view} />} extraCss={PAGE_CSS}>
      <p class="back"><a href={`${base}#a-${item.key}`}><Icon name="arrow-left" />Back to your answers</a></p>
      <p class="meta">Question {props.n} of {view.total}</p>
      <h1 class="question" id="question">{item.question}</h1>
      {item.answer ? <div class="card"><strong>Your answer now</strong><p class="pre">{item.answer}</p></div> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={`${base}/answers/${encodeURIComponent(item.key)}`} tap={item.tap} about={item.question} submit="Save this answer" skip={false} value={item.tap ? undefined : item.answer ?? undefined} />
    </ConversationPage>
  );
}

/**
 * Editing one written-up answer on Review & send: the question in large type, the answer as written up now (with the
 * assistant's note, labelled), and the box to change it, already holding it. What is saved is exactly what they wrote.
 */
function WrittenEditPage(props: { view: ConversationView; answer: WriteupAnswer; question: string; tap: TapFormat | null; n: number; total: number; error?: string | null }) {
  const { view, answer: a } = props;
  const base = screenPath(view.token);
  const words = a.answer.trim() ? a.answer : null;
  return (
    <ConversationPage view={view} title="Change your answer" header={<JourneyHeader view={view} />} extraCss={PAGE_CSS}>
      <p class="back"><a href={`${base}#w-${a.questionKey}`}><Icon name="arrow-left" />Back to what you're sending</a></p>
      <p class="meta">Question {props.n} of {props.total}</p>
      <h1 class="question" id="question">{props.question}</h1>
      {words ? <div class="card"><strong>Your answer now</strong><p class="pre">{words}</p></div> : null}
      {a.note ? <AssistantNote note={a.note} /> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={`${base}/answers/${encodeURIComponent(a.questionKey)}`} tap={props.tap} about={props.question} submit="Save this answer" skip={false} value={words ?? undefined} />
    </ConversationPage>
  );
}

/** The plan's address for "check your answers" (E10): the conversation's own page shows it once every question is done. */
candidatePages.get("/c/screen/:token/review", async (c) => {
  const found = await openConversation(c.get("container"), c.req.param("token"));
  if (!found) return c.notFound();
  return c.redirect(screenPath(found.ref.token));
});

/**
 * "Review and send" (the chat's end, and the bar on "Check your answers"): writes the answers up from the chat if that
 * is not done yet, then back to the conversation's page, which shows Review & send. Pressing twice writes once. Works
 * without script; the page's own script says "Sending…" while the assistant writes.
 */
candidatePages.post("/c/screen/:token/review", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await ensureWriteup(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});

/** Changing one answer (E10), or one written-up answer on Review & send. Only while the candidate is checking them; otherwise back to the conversation. */
candidatePages.get("/c/screen/:token/answers/:key", async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token"));
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  const view = await conversationView(container.db, found.ref);
  if (!view) return c.notFound();
  if (view.phase !== "review" || !view.review) return c.redirect(screenPath(view.token));
  const key = c.req.param("key");
  const error = c.req.query("error") ?? null;
  const written = view.writeup?.answers ?? [];
  const w = written.findIndex((a) => a.questionKey === key);
  if (w >= 0) {
    const item = view.review.find((i) => i.key === key);
    const question = view.written.find((q) => q.key === key)?.question ?? item?.question ?? key;
    c.header("Cache-Control", "no-store");
    return c.html(<WrittenEditPage view={view} answer={written[w]} question={question} tap={item?.tap ?? null} n={w + 1} total={written.length} error={error} />);
  }
  const at = view.review.findIndex((i) => i.key === key);
  if (at < 0) return c.notFound();
  c.header("Cache-Control", "no-store");
  return c.html(<EditPage view={view} item={view.review[at]} n={at + 1} error={error} />);
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
  // A written-up answer (Review & send): changed here, and the write-up holds what was saved.
  const view = await conversationView(container.db, found.ref);
  const written = !!view?.writeup?.answers.some((a) => a.questionKey === key);
  const out = written ? await editWrittenAnswer(container, found.ref, { questionKey: key, text: action.message ?? null, tap: action.tap ?? null }) : await conversationEdit(container, found.ref, { questionKey: key, text: action.message ?? null, tap: action.tap ?? null });
  if (out.ok) return c.redirect(`${base}?changed=${encodeURIComponent(key)}#${written ? "w" : "a"}-${key}`);
  const code = turnErrorCode(out.error);
  return c.redirect(code === "empty" || code === "tap" ? `${here}?error=${code}` : base);
});

/** "Send my answers" (E10): the conversation is complete. A second press changes nothing. */
candidatePages.post("/c/screen/:token/submit", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  // Once a chat is really sent, its record learns from it (Wave S7, S7-F). A repeat submission's copy is not the
  // candidate's until the address owner confirms it, which the confirmation page handles.
  if ((await conversationSubmit(container, found.ref)) && found.ref.kind === "screen") {
    // Best effort: the Send is committed already, so a failure here must never show the candidate an error page.
    // Learning is idempotent, so a later press of Send tries again.
    try {
      await learnFromSentChat(container, found.ref);
    } catch (err) {
      console.warn(`[screen] learning from the sent chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return c.redirect(screenPath(found.ref.token));
});
