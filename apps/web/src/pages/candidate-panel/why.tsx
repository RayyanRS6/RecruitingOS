"use client";

import type { ReactNode } from "react";

/**
 * The longer words behind a card's one line (Wave S1): one click away, never on the first view, in the one "show more"
 * pattern (`details.more`). The summary says what opens: "Why" by default, or "What happens next" before a decision.
 * Its place in a card comes from the card's own gap (every panel card lays its parts out as a grid).
 */
export function Why({ children, label = "Why" }: { children: ReactNode; label?: string }) {
  return (
    <details className="more">
      <summary>{label}</summary>
      <div className="small muted stack gap-1.5">{children}</div>
    </details>
  );
}

/*
 * The panel's shared looks (October 2026 redesign, docs/07): complete class strings, so Tailwind finds them here.
 */

/** A section card: its parts 12px apart, the title row flush with them (its chips wrap under the title on a phone). */
export const CARD = "grid gap-3 [&>.card-title]:mb-0 [&>.card-title]:flex-wrap";

/**
 * A card that waits on a person, under the panel's header: the "Your next step" wash (`needsYou`) made compact, its
 * parts 12px apart. A card there that waits on nobody keeps the same size on the plain surface.
 */
export const STEP = "grid gap-3 p-5 sm:p-6 [&>.card-title]:mb-0 [&>.card-title]:flex-wrap";

/** The one line under a step's title, in the second ink. */
export const LEAD = "small text-ink-2";

/** The candidate's own words: a lavender block with a plum rule on its left (spec section 7). */
export const QUOTE = "block rounded-r-[10px] border-l-2 border-primary bg-tint px-3 py-2 text-ink-2";

/** A small label over part of a card ("Strengths", "Must-haves"): the mono eyebrow. */
export const LABEL = "eyebrow";
