/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The design tokens (docs/07) are plain CSS; this reads them back and checks the promises the comments make: every
// earlier token name still works, the two dark blocks agree, and text and controls keep WCAG AA contrast in both themes.
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in tokens.css`);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const light = block(":root");
const darkByPreference = block(':root:not([data-theme="light"])');
const darkByChoice = block(':root[data-theme="dark"]');

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A token's colour in a theme: the dark blocks override the light one, and var() aliases are followed. */
function colour(theme: Map<string, string>, name: string): string {
  const value = theme.get(name) ?? light.get(name);
  if (!value) throw new Error(`${name} is not defined`);
  const alias = value.match(/^var\((--[a-z0-9-]+)\)$/);
  if (alias) return colour(theme, alias[1]);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a six-digit colour: ${value}`);
  return value;
}

// [text or mark, background, minimum]: 4.5 for text, 3 for focus rings and form-field borders (WCAG 1.4.3 / 1.4.11).
const PAIRS: Array<[string, string, number]> = [
  ["--ink", "--ground", 4.5],
  ["--ink", "--surface", 4.5],
  ["--ink-2", "--ground", 4.5],
  ["--ink-2", "--surface-2", 4.5],
  ["--ink-3", "--ground", 4.5],
  ["--ink-3", "--surface", 4.5],
  ["--ink-3", "--surface-2", 4.5],
  ["--ink-3", "--surface-rail", 4.5],
  ["--ink-3", "--good-soft", 4.5],
  ["--ink-3", "--caution-soft", 4.5],
  ["--on-primary", "--primary", 4.5],
  ["--on-primary", "--primary-hover", 4.5],
  ["--link", "--ground", 4.5],
  ["--link", "--surface", 4.5],
  ["--accent-ink", "--accent-soft", 4.5],
  ["--good", "--good-soft", 4.5],
  ["--good", "--surface", 4.5],
  ["--on-good-solid", "--good-solid", 4.5],
  ["--caution", "--caution-soft", 4.5],
  ["--caution", "--surface", 4.5],
  ["--critical", "--critical-soft", 4.5],
  ["--critical", "--surface", 4.5],
  ["--ground", "--ink", 4.5],
  ["--surface", "--ink", 4.5],
  ["--focus", "--ground", 3],
  ["--focus", "--surface", 3],
  ["--line-strong", "--surface", 3],
  ["--line-strong", "--ground", 3],
  // Added with the Obsidian-look work (10 October 2026): the sunken and pressed fills, the table band (--tint), and the
  // Apply now circle against its pill (a non-text boundary, 3:1).
  ["--ink", "--surface-2", 4.5],
  ["--ink-3", "--surface-3", 4.5],
  ["--ink", "--tint", 4.5],
  ["--ink-2", "--tint", 4.5],
  ["--ink-3", "--tint", 4.5],
  ["--link", "--tint", 4.5],
  ["--focus", "--surface-2", 3],
  ["--focus", "--tint", 3],
  ["--line-strong", "--surface-2", 3],
  ["--primary", "--surface-2", 3],
];

describe("design tokens", () => {
  it("keeps every earlier token name, so existing pages keep working", () => {
    const earlier = ["--bg", "--bg-2", "--bg-3", "--ink", "--ink-2", "--ink-3", "--line", "--accent", "--accent-ink", "--accent-soft", "--needs-you", "--needs-you-soft", "--good", "--good-soft", "--caution", "--caution-soft", "--critical", "--critical-soft", "--shadow", "--display", "--ui", "--mono", "--r-control", "--r-card", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6"];
    for (const name of earlier) expect(light.has(name), name).toBe(true);
  });

  it("defines dark mode the same way whether it comes from the system setting or from data-theme", () => {
    expect([...darkByChoice.entries()]).toEqual([...darkByPreference.entries()]);
    for (const name of darkByPreference.keys()) expect(light.has(name), `${name} has no light value`).toBe(true);
  });

  it("gives every colour in the light theme a dark value, or follows one that has", () => {
    for (const [name, value] of light) {
      if (!value.startsWith("#")) continue;
      expect(darkByPreference.has(name), `${name} has no dark value`).toBe(true);
    }
  });

  for (const [themeName, theme] of [["light", light], ["dark", darkByPreference]] as const) {
    it(`meets WCAG AA contrast in the ${themeName} theme`, () => {
      for (const [fg, bg, min] of PAIRS) {
        const ratio = contrast(colour(theme, fg), colour(theme, bg));
        expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it("keeps cobalt for links and focus only: primary buttons are near-black ink", () => {
    expect(colour(light, "--primary")).toBe(colour(light, "--ink"));
    expect(css).toMatch(/\.btn\.primary \{ background: var\(--primary\); color: var\(--on-primary\); \}/);
    expect(css).not.toMatch(/\.btn\.primary \{[^}]*--accent/);
  });

  it("puts the table band (--tint) between the surface and the sunken grey, in both themes", () => {
    for (const theme of [light, darkByPreference]) {
      const [s, t, s2] = ["--surface", "--tint", "--surface-2"].map((n) => luminance(colour(theme, n)));
      expect(t).toBeLessThanOrEqual(Math.max(s, s2));
      expect(t).toBeGreaterThanOrEqual(Math.min(s, s2));
    }
  });

  // Wave S6 (15 October 2026): in dark mode on Windows a dropdown's open list showed near-white words on a light list.
  it("colours every dropdown's open list itself, readable in both themes, and leaves the native arrow alone", () => {
    expect(css).toContain("select, option, optgroup { background-color: var(--surface); color: var(--ink); }");
    // an element rule, so a select without a class is covered; the .select class rule still dresses the closed control
    expect(css.indexOf("select, option, optgroup {")).toBeLessThan(css.indexOf(".input, .textarea, .select {"));
    expect(css).toMatch(/\.input, \.textarea, \.select \{[^}]*background: var\(--surface\); color: var\(--ink\);/);
    for (const theme of [light, darkByPreference, darkByChoice]) {
      const ratio = contrast(colour(theme, "--ink"), colour(theme, "--surface"));
      expect(ratio, `an option's words on its list are ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
    }
    // no drawn arrow: the native one follows color-scheme in both themes
    expect(css).not.toMatch(/appearance\s*:\s*none/);
    expect(css).toMatch(/:root \{[^}]*color-scheme: light;/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\) \{[^}]*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
  });

  it("edges an open menu with the stronger hairline, so it shows against the page in dark mode", () => {
    expect(css).toMatch(/\.menu \{[^}]*border: 1px solid var\(--line-2\);/);
    for (const theme of [light, darkByPreference]) expect(luminance(colour(theme, "--line-2"))).not.toBe(luminance(colour(theme, "--surface")));
  });

  it("keeps a pressed filter chip and the chosen tab visible under forced colours (Windows High Contrast)", () => {
    const forced = css.match(/@media \(forced-colors: active\) \{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(forced).toMatch(/\.toggle-chip\[aria-pressed="true"\] \{[^}]*forced-color-adjust: none;[^}]*background: Highlight;[^}]*color: HighlightText;/);
    expect(forced).toMatch(/\.tab\[aria-selected="true"\]::after \{[^}]*background: Highlight;/);
  });

  it("keeps the warm paper in the light theme and a cool, neutral grey in the dark one (founder decision Q1, 10 October 2026)", () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    for (const name of ["--ground", "--surface-2", "--surface-3", "--surface-rail", "--tint", "--line", "--line-2", "--line-strong", "--ink", "--ink-2", "--ink-3"]) {
      const [r, , b] = rgb(colour(light, name));
      expect(r, `${name} (light) is no longer warm`).toBeGreaterThan(b);
    }
    for (const name of ["--ground", "--surface", "--surface-2", "--surface-3", "--surface-rail", "--tint", "--line", "--line-2", "--line-strong", "--ink", "--ink-2", "--ink-3", "--primary", "--primary-hover", "--on-primary", "--neutral-dot"]) {
      const [r, , b] = rgb(colour(darkByPreference, name));
      expect(b, `${name} (dark) has a warm tint`).toBeGreaterThanOrEqual(r);
    }
  });
});
