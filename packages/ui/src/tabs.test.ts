import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./tabs";

/**
 * Tabs across (the default) and down the side (orientation="vertical", round 2 of the October 2026 redesign, spec 0d).
 * packages/ui has no DOM renderer, so Tabs is called as a plain function with the three React hooks it uses replaced by
 * stand-ins for one render (no state kept: the tests drive it controlled, with `value` and `onChange`). The shell's
 * tests render the real thing to markup.
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useId: () => ":r1:", useState: (initial: unknown) => [initial, () => undefined], useRef: (initial: unknown) => ({ current: initial }) };
});

type El = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in (n as object);
const kids = (el: El): El[] => [el.props.children].flat(Infinity as 1).filter(isEl);

const ITEMS = [
  { id: "company", label: "Company" },
  { id: "team", label: "Team" },
  { id: "alerts", label: "Notifications", disabled: true },
  { id: "rules", label: "Hiring rules" },
];

/** Draws the tabs with `value` chosen and returns the tab list, its buttons, and what a key press did. */
function draw(value: string, orientation?: "horizontal" | "vertical") {
  const chosen: string[] = [];
  const focused: number[] = [];
  const out = Tabs({ items: ITEMS, label: "Settings", value, onChange: (id) => chosen.push(id), orientation }) as El;
  const list = kids(out).find((e) => e.props.role === "tablist") as El;
  const buttons = kids(list).filter((e) => e.type === "button");
  for (const [i, b] of buttons.entries()) {
    (b.props.ref as (el: unknown) => void)({
      focus: () => {
        focused.push(i);
      },
    });
  }
  const press = (key: string) => {
    let prevented = false;
    const from = buttons.findIndex((b) => b.props["aria-selected"] === true);
    (buttons[from].props.onKeyDown as (e: unknown) => void)({
      key,
      preventDefault: () => {
        prevented = true;
      },
    });
    return { prevented, chosen: chosen.splice(0), focused: focused.splice(0) };
  };
  return { list, buttons, press };
}

describe("tabs across (the default)", () => {
  it("render the tab list as before: no aria-orientation, the attributes in their pinned order", () => {
    const { list, buttons } = draw("company");
    expect(list.props).toMatchObject({ role: "tablist", "aria-label": "Settings", className: "tabs", tabIndex: -1 });
    // undefined is left out of the markup: `<div role="tablist" aria-label="Settings" class="tabs" tabindex="-1">`
    expect(list.props["aria-orientation"]).toBeUndefined();
    expect(Object.keys(list.props).filter((k) => list.props[k] !== undefined)).toEqual(["role", "aria-label", "className", "tabIndex", "children"]);
    expect(buttons.map((b) => b.props.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("move with Left and Right, Home and End, past a disabled tab; Up and Down are left to the page", () => {
    const { press } = draw("team");
    expect(press("ArrowRight")).toEqual({ prevented: true, chosen: ["rules"], focused: [3] });
    expect(press("ArrowLeft")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
    expect(press("End")).toEqual({ prevented: true, chosen: ["rules"], focused: [3] });
    expect(press("Home")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "a"]) expect(press(key), key).toEqual({ prevented: false, chosen: [], focused: [] });
  });
});

describe("tabs down the side (orientation=\"vertical\")", () => {
  it("say they run down the side, with the same tabs, ids and Tab stop", () => {
    const { list, buttons } = draw("team", "vertical");
    expect(list.props).toMatchObject({ role: "tablist", "aria-label": "Settings", className: "tabs", "aria-orientation": "vertical", tabIndex: -1 });
    expect(buttons.map((b) => b.props.role)).toEqual(["tab", "tab", "tab", "tab"]);
    expect(buttons.map((b) => b.props.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(buttons[1].props).toMatchObject({ id: "tabsr1-tab-team", "aria-selected": true, className: "tab" });
  });

  it("move with Up and Down as with Left and Right, round the ends and past a disabled tab; Home and End unchanged", () => {
    const { press } = draw("team", "vertical");
    expect(press("ArrowDown")).toEqual({ prevented: true, chosen: ["rules"], focused: [3] });
    expect(press("ArrowUp")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
    expect(press("ArrowRight")).toEqual({ prevented: true, chosen: ["rules"], focused: [3] });
    expect(press("ArrowLeft")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
    expect(press("Home")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
    expect(press("End")).toEqual({ prevented: true, chosen: ["rules"], focused: [3] });
    expect(press("Enter")).toEqual({ prevented: false, chosen: [], focused: [] });
    // from the last tab, Down goes round to the first
    expect(draw("rules", "vertical").press("ArrowDown")).toEqual({ prevented: true, chosen: ["company"], focused: [0] });
  });
});
