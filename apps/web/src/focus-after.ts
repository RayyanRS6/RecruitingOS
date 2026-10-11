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
 * The job builder's question cards (plan C6): after the answers are sent, is it time to hand the focus on? Not while the
 * answers are on their way, and not before the reply's cards are drawn (the dock still shows the cards they were sent
 * from), unless the send failed and those cards stay.
 */
export function dockFocusDue(handOff: { from: string } | null, now: { dockKey: string; pending: boolean; failed: boolean }): boolean {
  if (!handOff || now.pending) return false;
  return now.dockKey !== handOff.from || now.failed;
}

/**
 * The Talent list after a row's stage button moved someone (plan A10): the row to put focus on. Still listed (an error,
 * or the "All" view): their own row, `same`. Gone from this view: the person now in that place, else the last one; null
 * when the list is empty (the list panel itself takes it then).
 */
export function rowFocusAfterMove(rowIds: readonly string[], moved: { id: string; index: number }): { id: string; same: boolean } | null {
  if (rowIds.includes(moved.id)) return { id: moved.id, same: true };
  if (!rowIds.length) return null;
  return { id: rowIds[Math.max(0, Math.min(moved.index, rowIds.length - 1))], same: false };
}
