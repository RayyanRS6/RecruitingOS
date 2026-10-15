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
 * The header's own styles: the shared tokens only, no motion. Each step is a numbered pill joined to the next by a short
 * line; the current one is filled in ink, a finished one shows a tick (its "(done)" is said to a screen reader). On a
 * phone only the current step keeps its words, so the three fit on one line.
 */
export const JOURNEY_CSS = `
.journey { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px; margin: 0 0 22px; padding: 0 0 14px; border-bottom: 1px solid var(--line); color: var(--ink-3); font-size: 14px; }
.journey ol { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0; padding: 0; list-style: none; counter-reset: journey; }
.journey li { display: inline-flex; align-items: center; gap: 8px; counter-increment: journey; font-weight: 600; }
.journey li::before { content: counter(journey); content: counter(journey) / ""; display: inline-grid; place-items: center; min-width: 26px; height: 26px; padding: 0 7px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink-3); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.journey li:not(:last-child)::after { content: ""; display: inline-block; width: 18px; height: 1px; background: var(--line-2); }
.journey li.current { color: var(--ink); }
.journey li.current::before { border-color: var(--ink); background: var(--ink); color: var(--ground); }
.journey li.done { color: var(--ink-2); }
.journey li.done::before { content: "\\2713"; content: "\\2713" / ""; border-color: var(--ink-3); color: var(--ink); }
.journey .journey-count { margin: 0; color: var(--ink-2); font-weight: 600; }
.journey .journey-later { display: flex; align-items: center; gap: 12px; margin: 0 0 0 auto; }
.journey .journey-later > span::before { content: ""; display: inline-block; width: 8px; height: 8px; margin: 0 6px 1px 0; border-radius: 50%; background: var(--ink-3); }
@media (max-width: 600px) {
  .journey li:not(.current) { font-size: 0; gap: 0; }
  .journey li:not(.current)::after { margin-left: 10px; }
}
`;
