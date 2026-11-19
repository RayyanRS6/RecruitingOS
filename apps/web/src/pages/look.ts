/**
 * Class strings the company's pages share that the kit has no class for, written out in full so Tailwind finds them
 * (never built from fragments). Pure strings; no behaviour, no words.
 */

/**
 * A row of a list whose title is a link covering the whole row (`ROW_TITLE`): the kit's row, a soft fill under the
 * mouse, and the title's keyboard focus ring drawn on the row, the same area a press opens. Anything else to press in
 * the row sits above the title's press area (`ROW_ABOVE`).
 */
export const LINKED_ROW = "list-row relative hover:bg-surface-2/60 has-[.list-row-title:focus-visible]:outline-2 has-[.list-row-title:focus-visible]:-outline-offset-2 has-[.list-row-title:focus-visible]:outline-focus";

/** The row's title link: the kit's row title, wrapping rather than cut short, its press area stretched over the row. */
export const ROW_TITLE = "list-row-title wrap after:absolute after:inset-0 focus-visible:outline-hidden";

/** A control inside a `LINKED_ROW`, kept above the title's press area. */
export const ROW_ABOVE = "relative z-[1]";

/** A plain list inside a card or a panel. */
export const BULLETS = "grid list-disc gap-1 pl-5 text-[14.5px] leading-relaxed marker:text-ink-3";

/** A section's small heading inside a card, a drawer or the job builder's pane. */
export const SUBHEAD = "font-display text-[16px] font-bold leading-snug tracking-[-0.01em] text-ink";
