/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { ChatCounter } from "@ros/contracts";

/**
 * The steps header across applying (Wave S7, spec step 5; redesign-spec 4.2 C1), slice S7-B. Server-rendered, works
 * without script: an ordered list with the current step marked for a screen reader, the chat's counter when the page is
 * the chat ("2 of 4 required · Required questions", founder decision S7-3), and "Saved" with "Finish later" (a plain
 * form posting to the conversation's `/later`, as the bottom link does). On conversation pages it sits directly under
 * the AI line (`ConversationPage`'s `header`); on the form it comes first. Its styles go in `JOURNEY_CSS`, passed as a
 * page's own styles (`extraCss`), never into the candidate stylesheet, whose budget is nearly spent. The apply form
 * and its "Reading your resume" page use it (pages/apply-form.tsx) when the chat follows in the same visit.
 */
export type JourneyStep = "details" | "chat" | "review";
export const JOURNEY_LABEL: Readonly<Record<JourneyStep, string>> = { details: "Details", chat: "Chat", review: "Review & send" };

export type JourneyProps = {
  /** The steps this application has, in order: all three in one visit; a later chat starts at "chat". */
  steps: JourneyStep[];
  current: JourneyStep;
  /** On the chat's pages: the counter and the section's name. */
  counter?: ChatCounter | null;
  /** On conversation pages: where "Finish later" posts (the conversation's `/later`), and that answers are saved as they go. */
  finishLater?: string | null;
};

export function Journey(props: JourneyProps) {
  const at = props.steps.indexOf(props.current);
  return (
    <nav class="journey" aria-label="Your application">
      <ol aria-label="Your application steps">
        {props.steps.map((s, i) => (
          <li class={i < at ? "done" : i === at ? "current" : undefined} aria-current={i === at ? "step" : undefined}>
            {JOURNEY_LABEL[s]}
            {i < at ? <span class="sr-only"> (done)</span> : null}
          </li>
        ))}
      </ol>
      {props.counter ? <p class="journey-count">{props.counter.label}</p> : null}
      {props.finishLater ? (
        <form method="post" action={props.finishLater} class="journey-later">
          <span>Saved</span>
          <button class="link-action" type="submit">Finish later</button>
        </form>
      ) : null}
    </nav>
  );
}

/**
 * The header's own styles (the October 2026 redesign, screenshot 5's "Application" line): the shared tokens only, no
 * motion. Each step is a mono label under its own segment of one thin line: the finished steps' segments in plum with a
 * tick (their "(done)" is said to a screen reader), the current one running from plum to coral, the steps to come in
 * the hairline grey. On a phone only the current step keeps its words, so the line stays one line.
 */
export const JOURNEY_CSS = `
.journey { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin: 0 0 28px; color: var(--ink-3); font-size: 14px; }
.journey ol { display: grid; flex: 1 1 100%; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 6px; margin: 0; padding: 0; list-style: none; }
.journey li { color: var(--ink-3); font: 400 11px/1.4 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; overflow-wrap: anywhere; }
.journey li::before { content: ""; display: block; height: 3px; margin-bottom: 10px; border-radius: var(--r-pill); background: var(--line); }
.journey li.done { color: var(--ink-2); }
.journey li.done::before { background: var(--primary); }
.journey li.done::after { content: " \\2713"; content: " \\2713" / ""; }
.journey li.current { color: var(--ink); }
.journey li.current::before { background: linear-gradient(90deg, var(--primary), var(--accent)); }
.journey .journey-count { margin: 0; color: var(--ink-2); font-weight: 600; }
.journey .journey-later { display: flex; align-items: center; gap: 12px; margin: 0 0 0 auto; }
.journey .journey-later > span::before { content: ""; display: inline-block; width: 8px; height: 8px; margin: 0 6px 1px 0; border-radius: 50%; background: var(--good); }
@media (max-width: 600px) {
  .journey li:not(.current) { font-size: 0; }
}
`;
