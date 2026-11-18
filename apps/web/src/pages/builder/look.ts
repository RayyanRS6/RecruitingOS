/**
 * The job builder's look: the class strings its parts share that the kit has no class for, written out in full so
 * Tailwind finds them (never built from fragments). Pure strings; no behaviour, no words. An answer to tick is the
 * kit's `.option-row`, and the assistant's mark is the kit's `IconChip size="xs"` (Conversation's AssistantMark).
 */

/**
 * The conversation and the job beside it: each a box of the same height with its own scroll, so the newest message
 * scrolls into view inside the conversation and the message box stays in reach. What sits above the panes, estimated
 * from the frame (not measured): under 900px the two-row top bar, the page's top, the title with its buttons on their
 * own line, and the Conversation/Job switch, about 316px in all; from 900px the bar, the top and the head, which still
 * wraps until the window is about 1050px wide (lg: about 226px above), and stays on one line from xl (about 172px).
 */
export const PANE_HEIGHT = "h-[calc(100dvh-316px)] min-h-[420px] lg:h-[calc(100dvh-226px)] lg:min-h-[520px] xl:h-[calc(100dvh-172px)]";

/** A group of answers to tick: rows of two when the box around them is wide enough (the dock is narrower than the page). */
export const OPTIONS = "grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-2";

/** The words of an answer in its `.option-row`: they take the room left, and a long word breaks rather than spill. */
export const OPTION_WORDS = "min-w-0 flex-[1_1_8rem] wrap-anywhere";

/** Words a person added themselves: chips with a remove button (a 40px target on a touch screen). */
export const OWN_CHIPS = "flex flex-wrap gap-1.5";
export const OWN_CHIP = "chip accent min-h-8 max-w-full gap-1 whitespace-normal py-0.5 pl-3 pr-0.5 text-[13px]";
export const OWN_CHIP_X = "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-primary transition-colors duration-150 ease-soft hover:bg-surface pointer-coarse:-my-1.5 pointer-coarse:size-10";
