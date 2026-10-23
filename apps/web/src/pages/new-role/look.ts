/**
 * The job builder's look (October 2026 redesign, docs/07): the class strings its parts share that the kit has no class
 * for, written out in full so Tailwind finds them (never built from fragments). Pure strings; no behaviour, no words.
 * An answer to tick is the kit's `.option-row` (with `.option-tag` for a status word at its end), who sees a part is
 * the `SeenBy` mark in marks.tsx (beside a field's label, the kit's `Field aside`), and the assistant's mark is the
 * kit's `IconChip size="xs"` (Conversation's AssistantMark).
 */

/**
 * The conversation and the draft beside it: each a box of the same height with its own scroll, so the newest message
 * scrolls into view inside the conversation (Conversation's auto-scroll) and the message box stays in reach.
 * What sits above the panes, estimated from the frame (not measured): under 900px the two-row top bar (about 120px),
 * the page's 20px top, the title with the actions on their own line, and the Conversation/Draft switch, about 316px in
 * all; from 900px the 64px bar, the 36px top and the head, which still wraps until the window is about 1050px wide
 * (lg: about 221px above), and stays on one line from xl (about 161px above).
 */
export const PANE_HEIGHT = "h-[calc(100dvh-316px)] min-h-[420px] lg:h-[calc(100dvh-226px)] lg:min-h-[520px] xl:h-[calc(100dvh-172px)]";

/** A group of answers to tick: rows of two when the box around them is wide enough (the dock is narrower than the page). */
export const OPTIONS = "grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-2";

/**
 * The words of an answer in its `.option-row`: they take the room left, and a long word breaks rather than spill. On an
 * OPTION_ROW_TAGGED row they keep at least 8rem before the tag drops below them.
 */
export const OPTION_WORDS = "min-w-0 flex-[1_1_8rem] wrap-anywhere";

/**
 * An `.option-row` with words at its end (an `.option-tag`: "Must-have", "AI suggestion"): the kit's row does not wrap,
 * so on a phone the tag drops to its own line instead of squeezing the answer.
 */
export const OPTION_ROW_TAGGED = "option-row flex-wrap gap-y-1.5";

/** A team member to pick: a pill with their initials; the native input covers it, unseen, so a click or a tap ticks it. */
export const TEAM_CHIP = "relative inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-line-2 bg-surface py-1 pl-1 pr-3.5 text-[14px] font-medium text-ink-2 transition-colors duration-150 ease-soft hover:border-line-strong hover:text-ink data-[checked=true]:border-primary data-[checked=true]:bg-tint-2 data-[checked=true]:text-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus [&_.avatar]:size-8 [&_.avatar]:text-[11px] [&>input]:absolute [&>input]:inset-0 [&>input]:m-0 [&>input]:size-full [&>input]:cursor-pointer [&>input]:opacity-0";

/** Words a person added themselves: chips with a remove button (a 40px target on a touch screen). */
export const OWN_CHIPS = "flex flex-wrap gap-1.5";
export const OWN_CHIP = "chip accent min-h-8 max-w-full gap-1 whitespace-normal py-0.5 pl-3 pr-0.5 text-[13px]";
export const OWN_CHIP_X = "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-primary transition-colors duration-150 ease-soft hover:bg-surface pointer-coarse:-my-1.5 pointer-coarse:size-10";

/** A heading inside the draft (Pay, What you'll do...). */
export const DRAFT_H3 = "font-display text-[16px] font-bold leading-snug tracking-[-0.01em] text-ink";

/** A part of the draft: a quiet card that lights up for a moment when it changed, and is marked while a change would touch it. */
export const DRAFT_PART = "grid min-w-0 gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5 transition-colors duration-200 ease-soft data-[changed=true]:border-line-tint data-[changed=true]:bg-tint data-[proposed=true]:border-accent/40 data-[proposed=true]:bg-peach/50";

/** The head of a part: its heading, and who sees it. */
export const DRAFT_PART_HEAD = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5";

/** A plain list inside the draft or the preview. */
export const BULLETS = "grid list-disc gap-1 pl-5 text-[14.5px] leading-relaxed marker:text-ink-3";
