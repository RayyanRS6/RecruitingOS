/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The design tokens (docs/07) are plain custom properties at the top of styles.css; this reads them back and checks the
// promises the comments make: the two dark blocks agree, every colour has a dark value, text and controls keep WCAG AA
// contrast in both themes, and the few global rules both themes depend on are there.
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

/** A flat token block: the declarations from `selector {` to the first closing brace (no nesting inside). */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in styles.css`);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  if (body.includes("{")) throw new Error(`${selector} is not a flat block`);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/** The body of the first `@media <query> {` block, found by matching braces. */
function mediaBody(query: string): string {
  const open = `@media ${query} {`;
  const at = css.indexOf(open);
  if (at < 0) return "";
  let depth = 1;
  let i = at + open.length;
  while (depth && i < css.length) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(at + open.length, i - 1);
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

const pairs = (fgs: string[], bgs: string[], min: number) => fgs.flatMap((fg) => bgs.map((bg): [string, string, number] => [fg, bg, min]));

// [text or mark, background, minimum]: 4.5 for text, 3 for focus rings, field borders and marks (WCAG 1.4.3 / 1.4.11).
const PAIRS: Array<[string, string, number]> = [
  // the three inks on every ground they are written on, the pressed grey and the soft signal fills included (a meta line
  // on a skeleton-grey band, under a green or amber note), and on the lavender chips and the peach end of the hero wash
  ...pairs(["--ink", "--ink-2", "--ink-3"], ["--ground", "--surface", "--surface-2", "--surface-3", "--tint", "--tint-2", "--peach"], 4.5),
  ...pairs(["--ink-3"], ["--good-soft", "--caution-soft"], 4.5),
  // the solid pills' words (Hired and the other finished states): the card's colour on a filled pill
  ...pairs(["--surface"], ["--ink-2", "--good", "--caution", "--critical"], 4.5),
  // plum: buttons, links, the chosen item, accent pills and avatars
  ...pairs(["--on-primary"], ["--primary", "--primary-hover"], 4.5),
  ...pairs(["--primary"], ["--ground", "--surface", "--surface-2", "--tint", "--tint-2"], 4.5),
  // the signals, on their own soft fills and on a card
  ...pairs(["--good"], ["--good-soft", "--surface"], 4.5),
  ...pairs(["--caution"], ["--caution-soft", "--surface"], 4.5),
  ...pairs(["--critical"], ["--critical-soft", "--surface"], 4.5),
  ...pairs(["--info"], ["--info-soft", "--surface"], 4.5),
  ...pairs(["--warm"], ["--warm-soft", "--surface"], 4.5),
  // coral words (the peach icon chip's mark, small coral text) and the coral spark itself (dots, sparkles: a mark)
  ...pairs(["--accent-ink"], ["--accent-soft", "--peach", "--ground", "--surface"], 4.5),
  ...pairs(["--accent"], ["--ground", "--surface"], 3),
  // the focus ring and the form fields' edge must be seen (the edge also rings the chosen segment on its sunken track)
  ...pairs(["--focus"], ["--ground", "--surface", "--surface-2", "--tint"], 3),
  ...pairs(["--line-strong"], ["--ground", "--surface", "--surface-2"], 3),
];

describe("design tokens", () => {
  it("keeps the token blocks flat, with color-scheme in each, so a theme switch flips every native control too", () => {
    expect(light.size).toBeGreaterThan(30);
    expect(css).toMatch(/:root \{[^}]*color-scheme: light;/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\) \{[^}]*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/);
    expect(css).toMatch(/:root\[data-theme="light"\] \{[^}]*color-scheme: light;/);
    // the device's dark setting only counts when no light theme was picked
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
  });

  it("defines dark mode the same way whether it comes from the system setting or from data-theme", () => {
    expect([...darkByChoice.entries()]).toEqual([...darkByPreference.entries()]);
    for (const name of darkByPreference.keys()) expect(light.has(name), `${name} has no light value`).toBe(true);
  });

  it("gives every colour in the light theme a dark value", () => {
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

  it("names only defined tokens in the Tailwind colour classes", () => {
    const theme = css.slice(css.indexOf("@theme inline {"), css.indexOf("}", css.indexOf("@theme inline {")));
    const used = [...theme.matchAll(/--color-[a-z0-9-]+:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(30);
    for (const name of used) expect(light.has(name), `${name} is not a token`).toBe(true);
    // Tailwind's own palette is switched off: only our colours exist as classes
    expect(theme).toContain("--color-*: initial;");
  });

  it("keeps the paper warm in the light theme and the dark one plum-tinted, never grey-brown", () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    for (const name of ["--ground", "--surface", "--surface-2", "--surface-3", "--line", "--line-2"]) {
      const [r, , b] = rgb(colour(light, name));
      expect(r, `${name} (light) is no longer warm`).toBeGreaterThan(b);
    }
    for (const name of ["--ground", "--surface", "--surface-2", "--surface-3", "--tint", "--line", "--line-2", "--line-strong", "--ink", "--ink-2", "--ink-3"]) {
      const [r, , b] = rgb(colour(darkByPreference, name));
      expect(b, `${name} (dark) has lost its plum`).toBeGreaterThanOrEqual(r);
    }
    // primary buttons are plum: blue over red over green, in both themes
    for (const theme of [light, darkByPreference]) {
      const [r, g, b] = rgb(colour(theme, "--primary"));
      expect(b).toBeGreaterThan(r);
      expect(r).toBeGreaterThan(g);
    }
    expect(css).toMatch(/\.btn\.primary \{ background: var\(--primary\); color: var\(--on-primary\);/);
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
    // form fields are edged in the field-border grey, 3:1 or more (checked above)
    expect(css).toMatch(/\.input, \.textarea, \.select \{[^}]*border: 1px solid var\(--line-strong\);/);
  });

  it("edges an open menu with the stronger hairline, so it shows against the page in dark mode", () => {
    expect(css).toMatch(/\.menu \{[^}]*border: 1px solid var\(--line-2\);/);
    for (const theme of [light, darkByPreference]) expect(luminance(colour(theme, "--line-2"))).not.toBe(luminance(colour(theme, "--surface")));
  });

  it("keeps a pressed filter chip, the chosen segment and the chosen tab visible under forced colours (Windows High Contrast)", () => {
    const forced = mediaBody("(forced-colors: active)");
    expect(forced).toMatch(/\.toggle-chip\[aria-pressed="true"\] \{[^}]*forced-color-adjust: none;[^}]*background: Highlight;[^}]*color: HighlightText;/);
    expect(forced).toMatch(/\.segmented button:is\(\.on, \[aria-pressed="true"\]\) \{[^}]*forced-color-adjust: none;[^}]*background: Highlight;[^}]*color: HighlightText;/);
    expect(forced).toMatch(/\.tab\[aria-selected="true"\]::after[^{]*\{[^}]*background: Highlight;/);
  });

  it("marks the chosen segment by an edge that can be seen (3:1 on its track), not by a near-white fill alone", () => {
    expect(css).toMatch(/\.segmented button:is\(\.on, \[aria-pressed="true"\]\) \{[^}]*box-shadow: 0 0 0 1px var\(--line-strong\)/);
    expect(css).toMatch(/\.segmented \{[^}]*background: var\(--surface-2\);/);
    for (const theme of [light, darkByPreference]) expect(contrast(colour(theme, "--line-strong"), colour(theme, "--surface-2"))).toBeGreaterThanOrEqual(3);
  });
});
