/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Alert, Button, Card, Chip, cn, EmptyState, ErrorState, Eyebrow, Icon, IconButton, IconChip, IconLabel, Pill, SectionHeader, Skeleton, StatCell, StatStrip } from "./index";

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
