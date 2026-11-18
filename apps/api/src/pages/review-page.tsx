/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import type { ReviewItem } from "@ros/contracts";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { conversationEdit, conversationSubmit, conversationView, type ConversationView } from "../services/screens";
import { CORRECTION_LINE, linkGone, screenPath } from "./candidate-shared";
import { ANSWER_KEY, AnswerForms, AsideActions, Bubble, ConversationPage, ErrorNote, openConversation, turnActionFrom, turnErrorCode } from "./conversation-frame";
import { Icon } from "./icons";
import { JOURNEY_CSS, Journey } from "./journey";

/**
 * "Check your answers" and sending them. The AI interview's own page (pages/chat-pages.tsx) shows `ReviewPage` once the
 * chat is over: every answer in the candidate's own words with its Change link, then "Send my answers". Nothing reaches
 * the team before Send. Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as reviewPages };

/** The steps header on these pages (pages/journey.tsx): the chat is done, this is the last step. */
function JourneyHeader() {
  return <Journey steps={["chat", "review"]} current="review" />;
}

/** These pages' own styles, passed as the page's own (`extraCss`): the form's answers as one soft card. Shared tokens only, no motion. */
export const REVIEW_SEND_CSS = `
.send-part { margin: 32px 0 0; }
.send-part > h2 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.02em; }
.send-part > p { color: var(--ink-2); }
.send-part > ul { margin: 12px 0; padding: 12px 18px 12px 34px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink); font-size: 14.5px; }
.send-part > ul > li + li { margin-top: 4px; }
`;

const PAGE_CSS = `${JOURNEY_CSS}${REVIEW_SEND_CSS}`;

/** Both halves stay true and in the page: nothing goes before Send, and what happens without Send is one click away. */
function WithoutSend() {
  return (
    <details class="more">
      <summary>What if I don't press Send?</summary>
      <p>If you do not press Send, the link closes five days after it was sent to you, and your application stays with the hiring team without these answers. We email you one reminder before then.</p>
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
 * What the AI interview's page shows once the chat is over (phase "review"): every answer with its Change link, changed
 * and skipped ones marked, what went with the form, the whole chat one click away, then Send. The team sees the answers
 * only once the candidate sends them, and nothing sends them for the candidate: someone who does not press Send has the
 * link closed after five days (the screen workflow), and the page says so.
 */
export function ReviewPage(props: { view: ConversationView; changed: string | null; error?: string | null }) {
  const { view } = props;
  const base = screenPath(view.token);
  const items = view.review ?? [];
  return (
    <ConversationPage view={view} title="Check your answers" header={<JourneyHeader />} extraCss={PAGE_CSS}>
      <h1>Check your answers</h1>
      <p class="lead">The hiring team sees your answers only once you send them.</p>
      <WithoutSend />
      {props.changed && items.some((i) => i.key === props.changed) ? <div class="card" role="status"><strong>Your answer is changed.</strong></div> : null}
      <ErrorNote code={props.error} />
      <ol class="answers">{items.map((item, i) => <AnswerItem item={item} n={i + 1} base={base} />)}</ol>
      {view.formAnswers.length ? (
        <section class="send-part" aria-labelledby="send-details">
          <h2 id="send-details">Sent with your application</h2>
          <ul>{view.formAnswers.map((s) => <li>{s}</li>)}</ul>
          <p>These went with your form, with your name, contact details and resume; this chat does not change them. {CORRECTION_LINE}</p>
        </section>
      ) : null}
      {view.transcript.length ? (
        <details class="more">
          <summary>See your whole chat</summary>
          <ol class="thread" aria-label="Your whole chat">{view.transcript.map((l) => <Bubble line={l} open={false} />)}</ol>
        </details>
      ) : null}
      <form method="post" action={`${base}/submit`}>
        <button class="btn" type="submit">Send my answers</button>
      </form>
      <AsideActions base={base} />
    </ConversationPage>
  );
}

/** Changing one answer, from "check your answers": the question in large type, the answer now, and a new one. */
function EditPage(props: { view: ConversationView; item: ReviewItem; n: number; total: number; error?: string | null }) {
  const { view, item } = props;
  const base = screenPath(view.token);
  return (
    <ConversationPage view={view} title="Change your answer" header={<JourneyHeader />} extraCss={PAGE_CSS}>
      <p class="back"><a href={`${base}#a-${item.key}`}><Icon name="arrow-left" />Back to your answers</a></p>
      <p class="meta">Question {props.n} of {props.total}</p>
      <h1 class="question" id="question">{item.question}</h1>
      {item.answer ? <div class="card"><strong>Your answer now</strong><p class="pre">{item.answer}</p></div> : null}
      <ErrorNote code={props.error} />
      <AnswerForms action={`${base}/answers/${encodeURIComponent(item.key)}`} tap={item.tap} about={item.question} submit="Save this answer" skip={false} value={item.tap ? undefined : item.answer ?? undefined} />
    </ConversationPage>
  );
}

/** The address of "check your answers": the AI interview's own page shows it once every question is done. */
candidatePages.get("/c/screen/:token/review", async (c) => {
  const found = await openConversation(c.get("container"), c.req.param("token"));
  if (!found) return c.notFound();
  return c.redirect(screenPath(found.ref.token));
});

/** Changing one answer. Only while the candidate is checking them; otherwise back to the AI interview's page. */
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
  return c.html(<EditPage view={view} item={view.review[at]} n={at + 1} total={view.review.length} error={c.req.query("error") ?? null} />);
});

/** The new answer, typed or tapped, added to the transcript beside the earlier one. */
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

/** "Send my answers": the AI interview is complete. A second press changes nothing. */
candidatePages.post("/c/screen/:token/submit", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const found = await openConversation(container, c.req.param("token") ?? "");
  if (!found) return c.notFound();
  if (found.gone) return linkGone(c);
  await conversationSubmit(container, found.ref);
  return c.redirect(screenPath(found.ref.token));
});
