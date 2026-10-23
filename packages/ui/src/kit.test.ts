/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Alert, Button, Card, Chip, cn, EmptyState, ErrorState, Eyebrow, Field, Icon, IconButton, IconChip, IconLabel, Kbd, PageHeader, Pill, SectionHeader, Segmented, Skeleton, StatCell, StatStrip, Table } from "./index";

/**
 * The kit's markup for the October 2026 redesign (docs/07): the layout helpers screens rely on (spec 5b) render the
 * classes styles.css draws, and the kit keeps no inline style of its own except a value that is data (a bar's width, a
 * menu placed against the window, a text box's measured height). The components are hook-free, so they are called
 * directly here (packages/ui has no DOM renderer); the shell's tests render the rest to markup.
 */
type El = ReactElement<{ children?: ReactNode; className?: string; style?: unknown; [key: string]: unknown }>;
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in (n as object);
const kids = (el: El): El[] => [el.props.children].flat(Infinity as 1).filter(isEl);
const tree = (el: El): El[] => [el, ...kids(el).flatMap(tree)];
const byClass = (el: El, className: string) => tree(el).find((e) => e.props.className === className);

describe("the layout helpers (spec 5b)", () => {
  it("StatStrip is one labelled group of cells", () => {
    const strip = StatStrip({ label: "Your jobs at a glance", children: "cells" }) as El;
    expect(strip.type).toBe("div");
    expect(strip.props).toMatchObject({ className: "stat-strip", role: "group", "aria-label": "Your jobs at a glance" });
  });

  it("StatCell shows what it counts over the figure, and is a link with an arrow when given an address", () => {
    const plain = StatCell({ label: "Open roles", value: 3 }) as El;
    expect(plain.type).toBe("div");
    expect(plain.props.className).toBe("stat-cell");
    expect(byClass(plain, "stat-cell-label")?.props.children).toBe("Open roles");
    expect(byClass(plain, "stat-cell-value")?.props.children).toBe(3);
    expect(byClass(plain, "stat-cell-go")).toBeUndefined();

    const link = StatCell({ label: "Applicants", value: 24, href: "/people", icon: "people", tone: "peach", note: "across your jobs" }) as El;
    expect(link.type).toBe("a");
    expect(link.props).toMatchObject({ className: "stat-cell", href: "/people" });
    expect(byClass(link, "stat-cell-go")?.props["aria-hidden"]).toBe("true");
    expect(byClass(link, "stat-cell-note")?.props.children).toBe("across your jobs");
    const chip = tree(link).find((e) => e.type === IconChip);
    expect(chip?.props).toMatchObject({ icon: "people", tone: "peach" });

    const message = StatCell({ label: "Every packet is reviewed before it is shared.", value: null, highlight: true }) as El;
    expect(message.props.className).toBe("stat-cell highlight");
    expect(byClass(message, "stat-cell-value")).toBeUndefined();
  });

  it("StatCell draws the app's own Link when given one (no full page load), with the same classes and arrow", () => {
    const seen: Array<{ href: string; className: string }> = [];
    const routed = StatCell({
      label: "Applicants",
      value: 24,
      href: "/talent",
      highlight: true,
      link: (cell) => {
        seen.push({ href: cell.href, className: cell.className });
        return createElement("span", { "data-router-link": cell.href, className: cell.className }, cell.children);
      },
    }) as El;
    expect(seen).toEqual([{ href: "/talent", className: "stat-cell highlight" }]);
    expect(routed.type).toBe("span");
    expect(routed.props).toMatchObject({ "data-router-link": "/talent", className: "stat-cell highlight" });
    expect(byClass(routed, "stat-cell-go")?.props["aria-hidden"]).toBe("true");
    expect(byClass(routed, "stat-cell-value")?.props.children).toBe(24);
    // without an address there is nothing to follow: the render is not called
    StatCell({ label: "Open roles", value: 3, link: () => { throw new Error("no link without an address"); } });
  });

  it("IconChip is a decorative tinted square around one icon, lavender and 40px unless asked", () => {
    const chip = IconChip({ icon: "briefcase" }) as El;
    expect(chip.type).toBe("span");
    expect(chip.props).toMatchObject({ className: "icon-chip lavender md", "aria-hidden": "true" });
    expect(kids(chip)[0].props).toMatchObject({ name: "briefcase", size: 18 });
    expect((IconChip({ icon: "sparkles", tone: "peach", size: "sm" }) as El).props.className).toBe("icon-chip peach sm");
    expect(kids(IconChip({ icon: "shield", size: "lg" }) as El)[0].props.size).toBe(22);
  });

  it("SectionHeader gives a section its heading (H2, or H3 when asked), a line under it and an action on the right", () => {
    const head = SectionHeader({ title: "Applications to pick up", sub: "Latest people who raised their hand.", eyebrow: "Recent activity", action: "link", id: "pick-up" }) as El;
    expect(head.props.className).toBe("section-header");
    const h2 = tree(head).find((e) => e.type === "h2");
    expect(h2?.props).toMatchObject({ id: "pick-up", children: "Applications to pick up" });
    expect(byClass(head, "section-header-sub")?.props.children).toBe("Latest people who raised their hand.");
    expect(byClass(head, "section-header-action")?.props.children).toBe("link");
    const small = SectionHeader({ title: "Open roles", level: 3 }) as El;
    expect(tree(small).some((e) => e.type === "h3")).toBe(true);
    expect(byClass(small, "section-header-action")).toBeUndefined();
  });
});

/**
 * Round 2 (spec 0d, 23 October 2026): screens pass their own placement classes to the kit instead of copying its class
 * strings, and a chip's words that only repeat what the screen shows become an icon with the words for screen readers.
 */
describe("the kit's round-2 contract", () => {
  // [without className, with className, the kit's own string as tests and e2e specs pin it, the attribute order]
  const cases: Array<[string, El, El, string, string[]]> = [
    ["Button", Button({ children: "Save", variant: "primary" }) as El, Button({ children: "Save", variant: "primary", className: "ml-auto" }) as El, "btn primary", ["type", "className", "onClick", "disabled", "title", "aria-label", "aria-pressed", "aria-busy", "aria-keyshortcuts", "children"]],
    ["IconButton", IconButton({ icon: "x", label: "Close", size: "sm" }) as El, IconButton({ icon: "x", label: "Close", size: "sm", className: "ml-auto" }) as El, "icon-btn sm", ["type", "className", "aria-label", "title", "onClick", "disabled", "children"]],
    ["IconChip", IconChip({ icon: "briefcase" }) as El, IconChip({ icon: "briefcase", className: "ml-auto" }) as El, "icon-chip lavender md", ["className", "aria-hidden", "children"]],
    ["Eyebrow", Eyebrow({ children: "AI interview" }) as El, Eyebrow({ children: "AI interview", className: "ml-auto" }) as El, "eyebrow", ["className", "children"]],
    ["Alert", Alert({ children: "Saved." }) as El, Alert({ children: "Saved.", className: "ml-auto" }) as El, "alert neutral", ["className", "role", "children"]],
    ["Pill", Pill({ children: "Live", tone: "good", size: "sm" }) as El, Pill({ children: "Live", tone: "good", size: "sm", className: "ml-auto" }) as El, "pill good sm", ["className", "title", "children"]],
    ["Chip", Chip({ children: "New" }) as El, Chip({ children: "New", className: "ml-auto" }) as El, "chip neutral", ["className", "children"]],
  ];

  it("renders the kit's own class string and attribute order unchanged when no className is passed", () => {
    for (const [name, plain, , kit, order] of cases) {
      expect(plain.props.className, name).toBe(kit);
      expect(Object.keys(plain.props), name).toEqual(order);
    }
    // the other tones keep their strings too
    expect((Alert({ children: "Could not save.", tone: "critical" }) as El).props).toMatchObject({ className: "alert critical", role: "alert" });
    expect((Chip({ children: "Must-have", tone: "accent" }) as El).props.className).toBe("chip accent");
    expect((Button({ children: "Sign in", variant: "primary", block: true }) as El).props.className).toBe("btn primary wide");
  });

  it("appends a caller's classes after the kit's own, in the same place among the attributes", () => {
    for (const [name, plain, extra, kit] of cases) {
      expect(extra.props.className, name).toBe(`${kit} ml-auto`);
      expect(Object.keys(extra.props), name).toEqual(Object.keys(plain.props));
    }
    // cn() joins them, so of two utilities of one kind the later wins
    expect((Button({ children: "Save", className: "px-2 px-4" }) as El).props.className).toBe("btn secondary px-4");
    // and a long status sentence wraps with the kit's own modifier
    expect((Pill({ children: "Waiting on the candidate's answers since Monday", tone: "caution", className: "wrap" }) as El).props.className).toBe("pill caution wrap");
  });

  it("never loses a kit class word to tailwind-merge, whatever utilities a screen adds", () => {
    const utilities = "block flex-wrap text-sm border border-solid rounded-full shadow-none p-2 wrap-anywhere outline-solid accent-current";
    for (const kit of ["btn primary sm wide", "btn danger", "btn quiet", "icon-btn sm", "chip needs", "chip source", "pill accent solid sm", "pill info wrap", "alert caution", "icon-chip plum lg", "icon-chip neutral sm", "eyebrow", "icon-label"]) {
      expect(cn(kit, utilities), kit).toBe(`${kit} ${utilities}`);
    }
  });

  it("Card draws a hero-sized title only when asked (`hero`), so a needs-you card in a panel keeps the card's own size", () => {
    const hero = Card({ children: "rows", needsYou: true, hero: true, lift: true, title: "Close this job" }) as El;
    expect(hero.type).toBe("section");
    expect(hero.props.className).toBe("card needs-you hero lift");
    expect(tree(hero).find((e) => e.type === "h2")?.props.children).toBe("Close this job");
    // without it, every class string is as before
    expect((Card({ children: "rows", needsYou: true, lift: true, title: "Put on hold" }) as El).props.className).toBe("card needs-you lift");
    expect((Card({ children: "rows", needsYou: true, title: "After the interview", className: "p-5" }) as El).props.className).toBe("card needs-you p-5");
    expect((Card({ children: "rows" }) as El).props.className).toBe("card");
  });

  it("IconLabel shows only its icon; the words are the screen reader's text and the tooltip", () => {
    const label = IconLabel({ icon: "eye", label: "Candidates see this" }) as El;
    expect(label.type).toBe("span");
    expect(label.props).toMatchObject({ className: "icon-label", title: "Candidates see this" });
    const [icon, words] = kids(label);
    expect(icon.type).toBe(Icon);
    expect(icon.props).toMatchObject({ name: "eye", size: 16 });
    // no label on the icon, so the icon hides itself from screen readers (it does not say the words twice)
    expect(icon.props.label).toBeUndefined();
    expect((Icon(icon.props as Parameters<typeof Icon>[0]) as El).props["aria-hidden"]).toBe("true");
    expect(words.props).toMatchObject({ className: "sr-only", children: "Candidates see this" });
    expect((IconLabel({ icon: "lock", label: "Only your team sees this", className: "ml-1" }) as El).props.className).toBe("icon-label ml-1");
  });
});

/**
 * Round 3 (23 October 2026): the small options whose absence made screens build their own copies (a hand-sized greeting,
 * a list card's header strip, a "(you)" tag, a numbered circle...). Each is additive: left out, the markup, the class
 * strings and the attribute order are exactly as before, which tests and e2e specs pin.
 */
describe("the kit's round-3 options", () => {
  it("PageHeader takes `hero` (Home's greeting size) and `className`; the H1 stays a bare <h1>", () => {
    const plain = PageHeader({ title: "Good morning, Dana" }) as El;
    expect(plain.type).toBe("header");
    expect(plain.props.className).toBe("page-header");
    expect(Object.keys(plain.props)).toEqual(["className", "children"]);
    const hero = PageHeader({ title: "Good morning, Dana", hero: true, className: "mb-0" }) as El;
    expect(hero.props.className).toBe("page-header hero mb-0");
    expect(Object.keys(hero.props)).toEqual(Object.keys(plain.props));
    expect((PageHeader({ title: "Jobs", className: "mb-3" }) as El).props.className).toBe("page-header mb-3");
    for (const el of [plain, hero]) {
      const h1 = tree(el).find((e) => e.type === "h1");
      expect(h1?.props.className).toBeUndefined();
      expect(h1?.props.children).toBe("Good morning, Dana");
    }
    // the grey title of a job not named yet keeps its one class
    const unnamed = PageHeader({ title: "Untitled role", placeholderTitle: true, hero: true }) as El;
    expect(tree(unnamed).find((e) => e.type === "h1")?.props.className).toBe("placeholder");
  });

  it("Segmented takes a `className` after its own", () => {
    const options = [{ value: "all", label: "All" }, { value: "mine", label: "Mine" }];
    const plain = Segmented({ value: "all", options, onChange: () => undefined, ariaLabel: "Show" }) as El;
    expect(plain.type).toBe("fieldset");
    expect(plain.props.className).toBe("segmented");
    expect(Object.keys(plain.props)).toEqual(["className", "aria-label", "children"]);
    const placed = Segmented({ value: "all", options, onChange: () => undefined, ariaLabel: "Show", className: "justify-self-start" }) as El;
    expect(placed.props.className).toBe("segmented justify-self-start");
    expect(Object.keys(placed.props)).toEqual(Object.keys(plain.props));
    // the choices are untouched
    expect(kids(placed).map((b) => [b.props.className, b.props["aria-pressed"]])).toEqual([["on", true], ["", false]]);
  });

  it("Button `keyshortcuts` announces a shortcut without drawing a key cap; `kbd` still draws and announces one", () => {
    const send = Button({ children: "Send", variant: "primary", keyshortcuts: "Control+Enter", title: "Send (Ctrl+Enter)" }) as El;
    expect(send.props["aria-keyshortcuts"]).toBe("Control+Enter");
    expect(send.props.className).toBe("btn primary");
    expect(tree(send).some((e) => e.type === Kbd)).toBe(false);
    expect(Object.keys(send.props)).toEqual(Object.keys((Button({ children: "Save" }) as El).props));
    const hinted = Button({ children: "Start a hire", kbd: "N" }) as El;
    expect(hinted.props["aria-keyshortcuts"]).toBe("N");
    expect(tree(hinted).find((e) => e.type === Kbd)?.props).toMatchObject({ decorative: true, children: "N" });
    expect((Button({ children: "Save" }) as El).props["aria-keyshortcuts"]).toBeUndefined();
  });

  it("IconChip comes in 28px (`xs`) with a 14px icon; Eyebrow can be a section's H2 or H3", () => {
    const xs = IconChip({ icon: "sparkles", tone: "peach", size: "xs" }) as El;
    expect(xs.props).toMatchObject({ className: "icon-chip peach xs", "aria-hidden": "true" });
    expect(kids(xs)[0].props).toMatchObject({ name: "sparkles", size: 14 });
    for (const as of ["h2", "h3"] as const) {
      const heading = Eyebrow({ children: "AI interview", as }) as El;
      expect(heading.type).toBe(as);
      expect(heading.props.className).toBe("eyebrow");
    }
    expect((Eyebrow({ children: "AI interview" }) as El).type).toBe("p");
  });

  it("Pill `busy` draws the spinner in the dot's place, hidden from screen readers; the word stays the text", () => {
    const reading = Pill({ children: "Reading", tone: "info", size: "sm", busy: true }) as El;
    expect(reading.props.className).toBe("pill info sm");
    const [mark] = kids(reading);
    expect(mark.props).toMatchObject({ className: "spinner", "aria-hidden": "true" });
    expect(tree(reading).some((e) => e.props.className === "dot")).toBe(false);
    expect([reading.props.children].flat()).toContain("Reading");
    // it wins over an icon, and without it the dot is back
    expect(kids(Pill({ children: "Reading", icon: "file-text", busy: true }) as El)[0].props.className).toBe("spinner");
    expect(kids(Pill({ children: "Live", tone: "good" }) as El)[0].props.className).toBe("dot");
  });

  it("Card `flush` is a list card: the class only, the title and its aside drawn as on any card", () => {
    const list = Card({ children: "rows", flush: true, title: "Needs attention", aside: "link" }) as El;
    expect(list.props.className).toBe("card flush");
    expect(byClass(list, "card-title")).toBeDefined();
    expect(tree(list).find((e) => e.type === "h2")?.props.children).toBe("Needs attention");
    expect((Card({ children: "rows", needsYou: true, hero: true, lift: true, flush: true, className: "mt-2" }) as El).props.className).toBe("card needs-you hero lift flush mt-2");
    expect((Card({ children: "rows", title: "Team" }) as El).props.className).toBe("card");
  });

  it("Field `aside` sits beside the label on its line; without it the label is the field's first child as before", () => {
    const plain = Field({ label: "Pay", htmlFor: "pay", hint: "Per hour", children: "input" }) as El;
    expect(plain.props.className).toBe("field");
    const [label, hint] = kids(plain);
    expect(label.type).toBe("label");
    expect(label.props).toEqual({ htmlFor: "pay", children: "Pay" });
    expect(hint.props).toMatchObject({ className: "hint", children: "Per hour" });
    expect(byClass(plain, "field-head")).toBeUndefined();

    const seen = IconLabel({ icon: "eye", label: "Candidates see this" });
    const beside = Field({ label: "Pay", htmlFor: "pay", aside: seen, children: "input" }) as El;
    const [head] = kids(beside);
    expect(head.type).toBe("div");
    expect(head.props.className).toBe("field-head");
    const [own, aside] = kids(head);
    expect(own.type).toBe("label");
    expect(own.props).toEqual({ htmlFor: "pay", children: "Pay" });
    expect(aside).toBe(seen);
    // the control follows the label's line, as it follows the bare label
    expect([beside.props.children].flat()[1]).toBe("input");
  });

  it("Table `wrapHeads` adds `wrap-heads` to the box; left out, the box is as before", () => {
    const plain = Table({ head: ["Job", "Applied"] }) as El;
    expect(plain.props.className).toBe("table-wrap");
    const wrapped = Table({ head: ["Job", { label: "Applicants who finished", num: true }], scroll: true, wrapHeads: true }) as El;
    expect(wrapped.props.className).toBe("table-wrap scroll wrap-heads");
    expect(Object.keys(wrapped.props)).toEqual(Object.keys(plain.props));
  });
});

describe("a toast on its way out", () => {
  it("is inert, and an open panel's Tab round skips it, so focus never lands on an Undo that can no longer be pressed", () => {
    const src = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    expect(src("./toast.tsx")).toContain("inert={!present || undefined}");
    expect(src("./sheet.tsx")).toContain('.filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"))');
    // a panel's round still takes in the toast region's controls (the Undo after Send)
    expect(src("./sheet.tsx")).toContain('const region = document.querySelector<HTMLElement>(".toast-region");');
  });
});

describe("the kit without inline styles", () => {
  it("fills the width with `wide`, never Tailwind's `block` (which would turn the button into a plain block)", () => {
    expect((Button({ children: "Sign in", variant: "primary", block: true }) as El).props.className).toBe("btn primary wide");
    expect((Button({ children: "Cancel", size: "sm" }) as El).props.className).toBe("btn secondary sm");
  });

  it("draws the loading lines, the empty state's action and the error's retry row from classes", () => {
    const loading = Skeleton({ lines: 4 }) as El;
    expect(loading.props).toMatchObject({ className: "stack", role: "status", "aria-busy": "true", "aria-label": "Loading" });
    expect(kids(loading)).toHaveLength(4);
    for (const line of kids(loading)) {
      expect(line.props.className).toBe("skeleton");
      expect(line.props.style).toBeUndefined();
    }
    const empty = EmptyState({ title: "No jobs yet", action: "Start a hire" }) as El;
    expect(byClass(empty, "empty-action")?.props.children).toBe("Start a hire");
    const failed = ErrorState({ message: "Could not load.", onRetry: () => undefined }) as El;
    expect(byClass(failed, "row error-state")).toBeDefined();
    for (const el of [...tree(empty), ...tree(failed)]) expect(el.props.style, String(el.type)).toBeUndefined();
  });

  it("keeps an inline style only for a value that is data", () => {
    const styles = (file: string) => (readFileSync(new URL(file, import.meta.url), "utf8").match(/style=\{/g) ?? []).length;
    expect(styles("./index.tsx")).toBe(1); // the pipeline's widths and colours per stage
    expect(styles("./score-bars.tsx")).toBe(1); // a bar's width
    expect(styles("./menu.tsx")).toBe(1); // a menu placed against the window inside a table's scrolling box
    for (const file of ["./sheet.tsx", "./tabs.tsx", "./toast.tsx", "./split-view.tsx", "./auto-textarea.tsx", "./motion-provider.tsx"]) expect(styles(file), file).toBe(0);
  });
});
