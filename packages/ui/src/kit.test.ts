/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Button, EmptyState, ErrorState, IconChip, SectionHeader, Skeleton, StatCell, StatStrip } from "./index";

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
