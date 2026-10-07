import { afterEach, describe, expect, it } from "vitest";
import { TOAST_EVENT } from "../../packages/ui/src/helpers";
import { toast } from "../../apps/web/src/toast";

/**
 * The toast() helper (docs/07): a title alone still travels as a plain string, the shape every Toaster has understood
 * from the start; a second line or a tone travels as one message the shell's Toaster shows on two lines.
 */
describe("toast()", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("sends a title alone as a plain string, and a second line or a tone as one message", () => {
    const page = new EventTarget();
    (globalThis as any).window = page;
    const seen: unknown[] = [];
    page.addEventListener(TOAST_EVENT, (e) => seen.push((e as CustomEvent).detail));
    toast("Saved.");
    toast("Moved to Shortlist.", "Private: the candidate was not told.");
    toast("Could not save.", { tone: "critical" });
    expect(seen).toEqual(["Saved.", { title: "Moved to Shortlist.", detail: "Private: the candidate was not told." }, { title: "Could not save.", tone: "critical" }]);
  });

  it("does nothing where there is no window (server rendering)", () => {
    expect(() => toast("Saved.")).not.toThrow();
  });
});
