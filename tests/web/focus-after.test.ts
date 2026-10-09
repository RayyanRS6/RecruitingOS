import { describe, expect, it } from "vitest";
import { dockFocusDue, focusLost, rowFocusAfterMove } from "../../apps/web/src/focus-after";

/**
 * Where keyboard focus goes when the control that had it goes away (docs/07): the job builder's question cards after
 * Send, and a Talent row whose stage button moved the person out of the view. Pure rules, tested here; the pages act on
 * them only when focus really was lost.
 */
describe("focus lost", () => {
  it("is focus on the page itself, or nowhere", () => {
    const body = {} as Element;
    const button = {} as Element;
    expect(focusLost(body, body)).toBe(true);
    expect(focusLost(null, body)).toBe(true);
    expect(focusLost(button, body)).toBe(false);
  });
});

describe("the job builder's cards after Send", () => {
  const sent = { from: "q1|q2|q3" };

  it("waits while the answers are on their way and until the reply's cards are drawn", () => {
    expect(dockFocusDue(sent, { dockKey: "q1|q2|q3", pending: true, failed: false })).toBe(false);
    // settled, but the screen still shows the cards the answers were sent from
    expect(dockFocusDue(sent, { dockKey: "q1|q2|q3", pending: false, failed: false })).toBe(false);
    // the reply drawn: new cards, or none left (the message box)
    expect(dockFocusDue(sent, { dockKey: "q4|q5", pending: false, failed: false })).toBe(true);
    expect(dockFocusDue(sent, { dockKey: "", pending: false, failed: false })).toBe(true);
  });

  it("hands focus back to the same card when the send failed, and never acts without a send", () => {
    expect(dockFocusDue(sent, { dockKey: "q1|q2|q3", pending: false, failed: true })).toBe(true);
    // a fresh load, or the cards changing for any other reason: nothing is taken
    expect(dockFocusDue(null, { dockKey: "q4", pending: false, failed: false })).toBe(false);
  });
});

describe("a Talent row after its stage button moved the person", () => {
  it("goes to the person now in that place when the row left the view", () => {
    // Priya (b) was second in a, b, c and is no longer in this view
    expect(rowFocusAfterMove(["a", "c"], { id: "b", index: 1 })).toEqual({ id: "c", same: false });
    // the last one moved: the one before takes it
    expect(rowFocusAfterMove(["a", "b"], { id: "c", index: 2 })).toEqual({ id: "b", same: false });
    expect(rowFocusAfterMove(["b", "c"], { id: "a", index: 0 })).toEqual({ id: "b", same: false });
  });

  it("stays on the same row when it is still listed, and leaves an empty list to the list panel", () => {
    expect(rowFocusAfterMove(["a", "b", "c"], { id: "b", index: 1 })).toEqual({ id: "b", same: true });
    expect(rowFocusAfterMove([], { id: "a", index: 0 })).toBeNull();
    // a row whose place was not known
    expect(rowFocusAfterMove(["a", "c"], { id: "b", index: -1 })).toEqual({ id: "a", same: false });
  });
});
