import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { menuSide } from "./menu";

/**
 * Where a menu opens (docs/07): on the side asked for, unless that runs past the edge of the window, where nothing can be
 * scrolled to (a phone's candidate panel, whose action buttons wrap onto a line of their own).
 */
describe("menuSide", () => {
  const PHONE = 375;
  const MENU = 232;

  it("keeps the side asked for when it fits", () => {
    expect(menuSide("end", { left: 280, right: 354 }, MENU, PHONE)).toBe("end");
    expect(menuSide("start", { left: 16, right: 90 }, MENU, PHONE)).toBe("start");
  });

  it("opens the other way when the side asked for would run past the edge and the other would not", () => {
    // More wrapped to the start of a line: opening leftward would put 142px off the screen
    expect(menuSide("end", { left: 15, right: 89 }, MENU, PHONE)).toBe("start");
    // a button at the right edge asked to open rightward
    expect(menuSide("start", { left: 300, right: 360 }, MENU, PHONE)).toBe("end");
  });

  it("keeps the side asked for when neither fits better, or nothing was measured", () => {
    expect(menuSide("end", { left: 0, right: 0 }, 0, 0)).toBe("end");
    expect(menuSide("start", { left: 100, right: 160 }, 400, 320)).toBe("start");
  });
});

describe("the candidate panel's actions on a phone", () => {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("end each wrapped line at the right, so a menu opening leftward stays on the screen", () => {
    const phone = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    const rule = phone.match(/\.drawer-actions \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/justify-content: flex-end/);
  });
});
