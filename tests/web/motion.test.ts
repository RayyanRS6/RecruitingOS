import { describe, expect, it } from "vitest";
import { scrollBehavior } from "../../apps/web/src/motion";

/** Scrolls a page starts itself respect "reduced motion" (docs/07); the CSS rule only covers transitions and animations. */
describe("scrolling started from code", () => {
  const asking = (reduce: boolean) => ({ matchMedia: (query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }) });

  it("jumps for anyone who asked for reduced motion, and scrolls smoothly otherwise", () => {
    expect(scrollBehavior(asking(true))).toBe("auto");
    expect(scrollBehavior(asking(false))).toBe("smooth");
  });

  it("jumps where the setting cannot be read (the server, tests, an old browser)", () => {
    expect(scrollBehavior(undefined)).toBe("auto");
    expect(scrollBehavior({})).toBe("auto");
    // here, in node, there is no window at all
    expect(scrollBehavior()).toBe("auto");
  });
});
