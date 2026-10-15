import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { Icon } from "./icons";
import { MenuLead, menuFixedAt, menuSide } from "./menu";

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

/**
 * The current choice of a one-of-many menu (the Jobs sort, the job switcher, a candidate's stage) shows a tick before its
 * words (Wave S6, 15 October 2026): before, it was only announced as checked and labelled by a small grey hint.
 */
describe("the tick on the current choice", () => {
  type Lead = ReactElement<{ name?: string; size?: number; className?: string; "aria-hidden"?: string }>;
  const lead = (item: Parameters<typeof MenuLead>[0]["item"]) => MenuLead({ item }) as Lead;

  it("puts a tick before the current choice, in place of its dot or icon", () => {
    for (const item of [{ id: "a", label: "Newest first", current: true }, { id: "b", label: "Shortlist", tone: "good" as const, current: true }, { id: "c", label: "Name", icon: "search" as const, current: true }]) {
      const el = lead(item);
      expect(el.type, item.label).toBe(Icon);
      expect(el.props.name, item.label).toBe("check");
      expect(el.props.size).toBe(16);
    }
  });

  it("keeps the other choices' dot, icon or empty slot, so the words stay lined up", () => {
    const dot = lead({ id: "b", label: "Shortlist", tone: "good", current: false });
    expect(dot.type).toBe("span");
    expect(dot.props.className).toBe("dot good");
    expect(dot.props["aria-hidden"]).toBe("true");
    const icon = lead({ id: "c", label: "Name", icon: "search" });
    expect(icon.type).toBe(Icon);
    expect(icon.props.name).toBe("search");
    const empty = lead({ id: "d", label: "Oldest first", current: false });
    expect(empty.type).toBe("span");
    expect(empty.props["aria-hidden"]).toBe("true");
  });

  it("draws every item's mark through MenuLead and still announces the current one as checked", () => {
    const src = readFileSync(new URL("./menu.tsx", import.meta.url), "utf8");
    expect(src).toContain("<MenuLead item={item} />");
    expect(src).toContain('{ role: "menuitemradio", "aria-checked": !!item.current }');
    expect(src).toContain('<span className="menu-hint">{props.currentLabel ?? "Current"}</span>');
  });
});

/**
 * A menu inside a table's scrolling box (.table-wrap scrolls sideways, so it clips whatever runs past its edges) is placed
 * against the window instead, so no part of it is ever cut off (Wave S6).
 */
describe("menuFixedAt", () => {
  const WIN = { width: 1366, height: 768 };
  const MENU = { width: 232, height: 200 };

  it("opens just below the button, on the side chosen", () => {
    expect(menuFixedAt("start", { top: 300, bottom: 332, left: 500, right: 580 }, MENU, WIN)).toEqual({ top: 338, left: 500 });
    expect(menuFixedAt("end", { top: 300, bottom: 332, left: 500, right: 580 }, MENU, WIN)).toEqual({ top: 338, left: 348 });
  });

  it("stays inside the window sideways", () => {
    expect(menuFixedAt("start", { top: 300, bottom: 332, left: 1300, right: 1360 }, MENU, WIN).left).toBe(1366 - 8 - 232);
    expect(menuFixedAt("end", { top: 300, bottom: 332, left: 4, right: 60 }, MENU, WIN).left).toBe(8);
  });

  it("opens above the button near the bottom of the window, and below it when there is more room there", () => {
    expect(menuFixedAt("start", { top: 700, bottom: 732, left: 500, right: 580 }, MENU, WIN)).toEqual({ top: 494, left: 500 });
    // a short window: neither side fits, so it takes the side with more room
    expect(menuFixedAt("start", { top: 100, bottom: 132, left: 500, right: 580 }, MENU, { width: 1366, height: 300 }).top).toBe(138);
    expect(menuFixedAt("start", { top: 200, bottom: 232, left: 500, right: 580 }, MENU, { width: 1366, height: 300 }).top).toBe(8);
  });

  it("is used only for a menu inside a table's scrolling box, and follows its button while things scroll", () => {
    const src = readFileSync(new URL("./menu.tsx", import.meta.url), "utf8");
    expect(src).toContain('wrap.current?.closest(".table-wrap")');
    expect(src).toContain('window.addEventListener("scroll", place, true);');
    // a button scrolled out of its table's box closes its menu, so it never floats over other rows
    expect(src).toContain("if (box && (at.bottom <= box.top || at.top >= box.bottom || at.right <= box.left || at.left >= box.right)) {");
    expect(src).toContain('style={fixedAt ? { position: "fixed", top: fixedAt.top, left: fixedAt.left, right: "auto" } : undefined}');
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
