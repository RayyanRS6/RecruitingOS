/**
 * The job builder's look (October 2026 redesign, docs/07): the class strings its parts share, written out in full so
 * Tailwind finds them (never built from fragments). Pure strings; no behaviour, no words.
 */

/**
 * The conversation and the draft beside it: each a box of the same height with its own scroll, so the newest message
 * scrolls into view inside the conversation (Conversation's auto-scroll) and the message box stays in reach.
 * What sits above the panes, estimated from the frame (not measured): under 900px the two-row top bar (about 120px),
 * the page's 20px top, the head with its actions on their own line, and the Conversation/Draft switch, about 340px in
 * all; from 900px the 64px bar, the 36px top and the head, which still wraps until the window is about 1050px wide
 * (lg: about 245px above), and stays on one line from xl (about 185px above).
 */
export const PANE_HEIGHT = "h-[calc(100dvh-340px)] min-h-[420px] lg:h-[calc(100dvh-250px)] lg:min-h-[520px] xl:h-[calc(100dvh-196px)]";

/** Who sees a part of the draft: a small quiet tag beside its heading (screenshot 3's "Advisory only"). */
export const SEEN_TAG = "inline-flex max-w-full items-center gap-1 rounded-[10px] border border-line bg-surface px-2 py-0.5 text-[12px] font-medium leading-snug text-ink-2 [&_.icon]:shrink-0 [&_.icon]:text-ink-3";

/** A group of answers to tick: rows of two when the box around them is wide enough (the dock is narrower than the page). */
export const OPTIONS = "grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-2";

/**
 * One answer to tick: a bordered row around the native radio or checkbox, tinted once chosen. Where the row is too
 * narrow for the answer and its tag side by side (a phone), the tag drops to a line of its own, at the right.
 */
export const OPTION_ROW = "flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14.5px] leading-snug text-ink transition-colors duration-150 ease-soft hover:border-line-strong has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 data-[checked=true]:border-line-tint data-[checked=true]:bg-tint";

/** The answer's words: at least 5rem before the tag gives way, and a long word breaks rather than spill. */
export const OPTION_LABEL = "min-w-0 flex-[1_1_5rem] wrap-anywhere";

/** Where an offered answer came from, at the end of its row. */
export const OPTION_TAG = "ml-auto max-w-full shrink-0 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] uppercase leading-relaxed tracking-[0.1em] text-ink-2";

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
