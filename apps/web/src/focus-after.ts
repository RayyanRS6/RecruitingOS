/**
 * Where keyboard focus goes when the control that had it goes away (docs/07: focus is never dropped on the page), kept
 * free of React and the DOM so it can be tested (tests/web/focus-after.test.ts). Each page acts only when focus really
 * was lost (on the page body), so nothing is taken from wherever the person has moved on to.
 */

/** True when focus was dropped on the page itself (the control that had it was removed or turned disabled). */
export function focusLost(active: Element | null, body: Element | null): boolean {
  return !active || active === body;
}

/**
 * The job builder's question cards: after the answers are sent, is it time to hand the focus on? Not while the answers
 * are on their way, and not before the reply's cards are drawn (the dock still shows the cards they were sent from),
 * unless the send failed and those cards stay.
 */
export function dockFocusDue(handOff: { from: string } | null, now: { dockKey: string; pending: boolean; failed: boolean }): boolean {
  if (!handOff || now.pending) return false;
  return now.dockKey !== handOff.from || now.failed;
}
