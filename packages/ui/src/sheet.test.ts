import { describe, expect, it } from "vitest";
import { normalizeToast, toastArrives, toastPayload } from "./helpers";
import { tabStep } from "./sheet";

/**
 * Keyboard inside an open drawer or dialog (docs/07): Tab goes round the panel's own controls and, while a toast shows
 * one (an Undo after Send, which sits outside every panel), the toast's too; nothing behind the panel is reached.
 */
describe("tabStep: the round of Tab inside an open panel", () => {
  // a panel with 3 controls (places 0, 1, 2) and a toast showing an Undo (place 3)
  const withUndo = { own: 3, toasts: 1, onPanel: false };
  const without = { own: 3, toasts: 0, onPanel: false };

  it("leaves moves between the panel's own controls to the browser", () => {
    expect(tabStep({ ...withUndo, at: 0, back: false })).toBeNull();
    expect(tabStep({ ...withUndo, at: 2, back: true })).toBeNull();
    expect(tabStep({ ...without, at: 1, back: false })).toBeNull();
  });

  it("goes from the panel's last control to the toast's Undo, and from there back to the first", () => {
    expect(tabStep({ ...withUndo, at: 2, back: false })).toBe(3);
    expect(tabStep({ ...withUndo, at: 3, back: false })).toBe(0);
    // and backwards: the first control to the Undo, the Undo to the panel's last control
    expect(tabStep({ ...withUndo, at: 0, back: true })).toBe(3);
    expect(tabStep({ ...withUndo, at: 3, back: true })).toBe(2);
  });

  it("without a toast, wraps round the panel's controls as before", () => {
    expect(tabStep({ ...without, at: 2, back: false })).toBe(0);
    expect(tabStep({ ...without, at: 0, back: true })).toBe(2);
  });

  it("brings focus that slipped out of the panel back in, and leaves the panel itself to the browser going forward", () => {
    expect(tabStep({ ...withUndo, at: -1, back: false })).toBe(0);
    expect(tabStep({ ...withUndo, at: -1, back: true })).toBe(3);
    expect(tabStep({ ...withUndo, at: -1, onPanel: true, back: false })).toBeNull();
    expect(tabStep({ ...withUndo, at: -1, onPanel: true, back: true })).toBe(3);
  });
});

/** Toasts (docs/07): a plain toast never takes away an Undo that can still be pressed; it waits for it to end. */
describe("toastArrives", () => {
  const undo = { title: "Decision message sent.", action: { label: "Undo", onAction: () => undefined }, durationMs: 30_000 };

  it("shows a plain toast at once when no action is on screen", () => {
    expect(toastArrives(false, { title: "Saved." })).toBe("show");
  });

  it("makes a plain toast wait while an Undo can still be pressed", () => {
    expect(toastArrives(true, { title: "Saved." })).toBe("wait");
  });

  it("shows at once a toast with an action of its own, or the one that answers the Undo on screen", () => {
    expect(toastArrives(true, undo)).toBe("show");
    expect(toastArrives(true, { title: "Taken back.", endsAction: true })).toBe("show");
  });

  it("carries endsAction through the event", () => {
    expect(normalizeToast(toastPayload("Taken back.", { endsAction: true }))).toEqual({ title: "Taken back.", endsAction: true });
    expect(normalizeToast(toastPayload("Taken back.", { detail: "Not sent.", endsAction: true }))).toEqual({ title: "Taken back.", detail: "Not sent.", endsAction: true });
    expect(normalizeToast("Saved.")).toEqual({ title: "Saved." });
  });
});
