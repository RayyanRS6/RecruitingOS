/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * What keeps the product light on old laptops and phones (docs/07; founder decisions of 10 October 2026): no styling,
 * animation, component or icon library in any package; CSS-only motion on transform and opacity, 200ms or less except
 * the named loops; nothing blurred; presses only when motion is welcome; hover fills only where there is a mouse;
 * reduced motion stops everything, pseudo-elements included; and the stylesheets stay within their byte budgets.
 * Raising a budget is a deliberate edit to this file, with the reason in the commit.
 */
const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8").replace(/\r\n/g, "\n");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const layout = read("apps/api/src/pages/layout.tsx");
const from = layout.indexOf("export const CSS = `") + "export const CSS = `".length;
/** The candidate pages' inline stylesheet as it ships (comments included: nothing minifies it), without the font faces. */
const candidate = layout.slice(from, layout.indexOf("`;", from)).replace(/\$\{fontFaceCss\(\)\}/, "");
const tokens = read("packages/ui/src/tokens.css");
const board = read("packages/ui/src/board.css");
const shell = read("apps/shell/components/app-shell.css");
const SHEETS: Array<[string, string]> = [["the application's styles", strip(`${tokens}\n${board}\n${shell}`)], ["the candidate pages' styles", strip(candidate)]];

const DUR: Record<string, number> = { "var(--dur-fast)": 150, "var(--dur)": 200 };
const durations = (value: string) => [...value.matchAll(/var\(--dur(?:-fast)?\)|(\d*\.?\d+)(ms|s)\b/g)].map((d) => (d[0].startsWith("var(") ? DUR[d[0]] : d[2] === "s" ? Number(d[1]) * 1000 : Number(d[1])));
function keyframes(css: string): Array<{ name: string; props: string[] }> {
  const out: Array<{ name: string; props: string[] }> = [];
  for (const m of css.matchAll(/@keyframes ([\w-]+) \{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    while (depth && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push({ name: m[1], props: [...css.slice((m.index ?? 0) + m[0].length, i - 1).matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]) });
  }
  return out;
}
/** Whether position `at` sits inside an open `@media <query> {` block. */
function insideMedia(css: string, at: number, query: string): boolean {
  const open = `@media ${query} {`;
  const start = css.lastIndexOf(open, at);
  if (start < 0) return false;
  let depth = 0;
  for (let i = start + open.length - 1; i < at; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    if (depth === 0) return false;
  }
  return depth > 0;
}
const HOVER_MEDIA = "(hover: hover) and (pointer: fine)";
/** Every rule that fills a background on :hover, and where it starts (a fill left behind by a tap on a phone shows). */
function hoverFills(css: string): Array<{ selector: string; at: number }> {
  return [...css.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)].filter((m) => /(?:^|[;\s])background(?:-color)?\s*:/.test(m[2])).map((m) => ({ selector: m[1].trim(), at: m.index ?? 0 }));
}
/** Endless animations allowed: the two this work adds (loading fade, Live ring) and the two that were already there. */
const LOOPS = new Set(["skeleton-pulse", "live-ping", "spin", "dot-bounce"]);
/**
 * One-off animations older than this rule, kept on purpose: the 2.4s highlight on a draft section that just changed,
 * which fades a background. Only these may run longer than 200ms or animate anything but transform and opacity.
 */
const OLDER_ONE_OFFS = new Set(["draft-flash"]);

describe("nothing heavier on old devices", () => {
  it("lists no styling, animation, component or icon library in any package", () => {
    const FORBIDDEN = /^(tailwindcss|@tailwindcss\/.+|tw-animate-css|tailwind-merge|clsx|class-variance-authority|motion|framer-motion|gsap|three|postprocessing|@react-three\/.+|@radix-ui\/.+|lucide-react|@lucide\/.+|lenis|@studio-freight\/lenis|recharts|@number-flow\/react|@paper-design\/shaders-react|vaul|sonner)$/;
    const files = ["package.json", ...["apps", "packages"].flatMap((dir) => readdirSync(new URL(`${dir}/`, repo)).map((name) => `${dir}/${name}/package.json`))].filter((f) => existsSync(new URL(f, repo)));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const pkg = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) for (const name of Object.keys(pkg[field] ?? {})) expect(name, `${file} ${field}`).not.toMatch(FORBIDDEN);
    }
  });

  for (const [label, css] of SHEETS) {
    it(`${label}: blur nothing`, () => {
      expect(css).not.toMatch(/backdrop-filter|filter:\s*blur\(/);
    });

    it(`${label}: animate only transform and opacity, and loop only the loading fade, the live ring, the spinner and the typing dots`, () => {
      const names = new Set<string>();
      for (const k of keyframes(css)) {
        names.add(k.name);
        if (OLDER_ONE_OFFS.has(k.name)) continue;
        for (const p of k.props) expect(p, `@keyframes ${k.name}`).toMatch(/^(transform|opacity)$/);
      }
      for (const m of css.matchAll(/animation:\s*([^;}]+)/g)) {
        const v = m[1].trim();
        if (v.startsWith("none")) continue;
        const name = v.split(/\s+/).find((w) => names.has(w)) ?? v;
        if (/\binfinite\b/.test(v)) expect(LOOPS.has(name), `endless animation ${name}`).toBe(true);
        else if (!OLDER_ONE_OFFS.has(name)) for (const d of durations(v)) expect(d, `animation ${v}`).toBeLessThanOrEqual(200);
      }
    });

    it(`${label}: keep every transition to 200ms or less, on nothing that moves the layout`, () => {
      for (const m of css.matchAll(/transition(?:-duration)?:\s*([^;}]+)/g)) {
        if (m[1].trim().startsWith("none")) continue;
        for (const d of durations(m[1])) expect(d, `transition ${m[1]}`).toBeLessThanOrEqual(200);
        expect(m[1]).not.toMatch(/\b(width|height|box-shadow|top|left|margin|padding)\b/);
      }
    });

    it(`${label}: stop every transition and animation for reduced motion, pseudo-elements included`, () => {
      expect(css).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }");
    });

    it(`${label}: press (a transform on :active) only when motion is welcome`, () => {
      for (const m of css.matchAll(/[^{}]*:active[^{}]*\{[^}]*transform:(?!\s*none)/g)) expect(insideMedia(css, m.index ?? 0, "(prefers-reduced-motion: no-preference)"), m[0].trim()).toBe(true);
    });

    it(`${label}: fill a background on hover, or slide the arrow pill's fill, only where there is a mouse`, () => {
      for (const f of hoverFills(css)) expect(insideMedia(css, f.at, HOVER_MEDIA), f.selector).toBe(true);
      for (const m of css.matchAll(/\.btn\.go:hover \.go-fill/g)) expect(insideMedia(css, m.index ?? 0, HOVER_MEDIA), m[0]).toBe(true);
    });
  }

  it("finds the hover fills it guards, so the check above cannot pass by finding none", () => {
    const [[, app], [, cand]] = SHEETS;
    const found = (css: string) => hoverFills(css).map((f) => f.selector);
    for (const sel of [".table tbody tr:hover > :is(td, th):not(.table-empty)", ".btn.primary:hover", ".menu-item:hover", ".talent-row:hover", ".section-menu a:hover", ".person-chip:hover"]) expect(found(app)).toContain(sel);
    for (const sel of [".btn:hover", ".btn.secondary:hover", "input[type=file]::file-selector-button:hover"]) expect(found(cand)).toContain(sel);
    expect(cand).toContain(".btn.go:hover .go-fill");
  });

  it("would catch a new ungated hover fill, a keyframe on anything but transform and opacity, and a press outside the motion query", () => {
    const [[, app]] = SHEETS;
    const probe = `${app}\n.probe:hover { background: red; }`;
    expect(hoverFills(probe).filter((f) => !insideMedia(probe, f.at, HOVER_MEDIA)).map((f) => f.selector)).toEqual([".probe:hover"]);
    for (const prop of ["background-color", "color", "border-color", "outline"]) expect(keyframes(`@keyframes probe { to { ${prop}: red; } }`)[0].props).toEqual([prop]);
    expect(keyframes(app).filter((k) => k.props.some((p) => !/^(transform|opacity)$/.test(p))).map((k) => k.name)).toEqual(["draft-flash"]);
    const press = `${app}\n.probe:active { transform: scale(0.9); }`;
    expect(insideMedia(press, press.lastIndexOf(".probe:active"), "(prefers-reduced-motion: no-preference)")).toBe(false);
  });

  it("moves the live ring, never the dot, and fades the skeleton instead of sliding it", () => {
    const [[, app]] = SHEETS;
    expect(app).not.toMatch(/@keyframes (pulse|shimmer) /);
    expect(app).not.toMatch(/\.dot\.pulse \{[^}]*animation/);
    expect(app).toMatch(/\.dot\.pulse::after \{[^}]*animation: live-ping /);
    expect(app).toMatch(/\.skeleton \{[^}]*animation: skeleton-pulse /);
    expect(app).not.toMatch(/\.skeleton \{[^}]*gradient/);
    // the skeleton is the pressed grey, a step darker than the sunken one, and never fades below 60%, so it always shows
    expect(app).toMatch(/\.skeleton \{ background: var\(--surface-3\);/);
    expect(app).toContain("@keyframes skeleton-pulse { 50% { opacity: 0.6; } }");
  });

  it("keeps the stylesheets within their byte budgets (gzip level 9; app sheets without comments, as the build ships them)", () => {
    const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).length;
    // 10 October 2026, before → after the Obsidian-look slices P and A: tokens 11,029 → 11,735; board 2,023 → 2,045;
    // app-shell 759 → 782; candidate 4,522 → 5,022 (with comments, as shipped).
    expect(gz(strip(tokens))).toBeLessThanOrEqual(12_000);
    expect(gz(strip(board))).toBeLessThanOrEqual(2_100);
    expect(gz(strip(shell))).toBeLessThanOrEqual(820);
    expect(gz(candidate)).toBeLessThanOrEqual(5_100);
  });
});

/** The look these stylesheets promise (docs/07; founder decisions Q2 and Q3, 10 October 2026), read back from the CSS. */
describe("the clean look", () => {
  const app = strip(tokens);
  const cand = strip(candidate);
  /** The declarations of the first rule whose selector is exactly `selector`. */
  const rule = (css: string, selector: string) => {
    const at = css.search(new RegExp(`(^|[\\n{}])\\s*${selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&")} \\{`));
    expect(at, `no ${selector} rule`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", css.indexOf(selector, at));
    return css.slice(open + 1, css.indexOf("}", open));
  };

  it("draws table headings in normal case, darker grey, on the faint band, and keeps the 12px cell padding", () => {
    const head = rule(app, ".table thead th");
    expect(head).not.toMatch(/text-transform|letter-spacing/);
    expect(head).toMatch(/font-size: 12\.5px; font-weight: 600; color: var\(--ink-2\); background: var\(--tint\);/);
    expect(head).toContain("padding: 10px 12px;");
    expect(rule(app, ".table td, .table tbody th")).toContain("padding: 11px 12px;");
    expect(rule(app, ".table .num")).toContain("text-align: right;");
  });

  it("tints the row under a mouse, keeps headings and the first column in view on solid fills, and draws one frame inside a card", () => {
    expect(rule(app, ".table tbody tr:hover > :is(td, th):not(.table-empty)")).toContain("background: var(--tint);");
    const sticky = app.indexOf(".table-wrap.scroll thead th {");
    expect(insideMedia(app, sticky, "(min-width: 901px)")).toBe(true);
    expect(rule(app, ".table-wrap.scroll thead th")).toContain("position: sticky; top: 0;");
    expect(rule(app, ".table-wrap.pin-first :is(th, td):first-child")).toContain("position: sticky; left: 0;");
    expect(rule(app, ".table-wrap.pin-first tbody :is(th, td):first-child")).toContain("background: var(--surface);");
    expect(rule(app, ".card .table-wrap")).toContain("margin-inline: -20px; border-width: 1px 0; border-radius: 0;");
    // the scrollbar's thumb is the field-border grey (3:1 or more on the surface), not a hairline
    expect(rule(app, ".table-wrap")).toContain("scrollbar-color: var(--line-strong) transparent;");
  });

  it("keeps a sorting heading's words on the plain headings' line, and the no-rows words in view on a phone", () => {
    // top-aligned: on its baseline a figure column's button (arrows first, row-reverse) stands higher than the words beside it
    expect(rule(app, ".th-sort")).toContain("vertical-align: top;");
    // the no-rows cell spans every column, so centred words would sit mid-table, off the edge of a phone's box
    expect(rule(app, ".table td.table-empty")).toContain("text-align: left;");
    expect(rule(app, ".table td.table-empty")).not.toContain("center");
    // nor is it pinned with the first column (no stray divider at the far edge); it undoes that rule, so it comes after it
    expect(rule(app, ".table-wrap.pin-first td.table-empty")).toBe(" position: static; box-shadow: none; ");
    expect(app.indexOf(".table-wrap.pin-first td.table-empty {")).toBeGreaterThan(app.indexOf(".table-wrap.pin-first :is(th, td):first-child {"));
  });

  it("styles every class the Table, Stat and Tabs components render", () => {
    for (const sel of [".table-wrap.scroll", ".table-wrap.pin-first :is(th, td):first-child", ".th-sort", ".table th.num .th-sort", ".table td.table-empty", ".table .skeleton", ".stat-row", ".stat", ".stat-n", ".stat-label", ".daybars", ".tab-label", ".dot.pulse::after"]) expect(app, sel).toContain(`${sel} {`);
  });

  it("keeps a tab's label the width of its bold self, the copy hidden from screen readers", () => {
    expect(rule(app, ".tab-label::after")).toBe(" content: attr(data-label); height: 0; overflow: hidden; visibility: hidden; font-weight: 600; pointer-events: none; user-select: none; ");
    expect(rule(app, '.tab[aria-selected="true"], .tab[aria-current="page"]')).toContain("font-weight: 600;");
  });

  it("presses a control to 97% and keeps button hovers behind the mouse query, in their old order", () => {
    expect(app).toContain(':is(.btn, .icon-btn, .pill-button, .toggle-chip, .segmented button):active:not(:disabled, [aria-disabled="true"]) { transform: scale(0.97); }');
    for (const sel of [".btn", ".icon-btn", ".pill-button", ".segmented button", ".toggle-chip"]) expect(rule(app, sel), sel).toMatch(/transition: [^;]*transform var\(--dur-fast\) var\(--ease\)/);
    const order = [".btn.primary:hover", ".btn.secondary:hover", ".btn.ghost:hover", ".btn.danger:hover"].map((s) => app.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(Math.min(...order)).toBeGreaterThan(app.indexOf(".btn.danger, .btn.destructive {"));
    expect(Math.max(...order)).toBeLessThan(app.indexOf(".btn:disabled"));
    // the menu keeps its keyboard fill on every device; only the pointer's fill waits for a mouse
    expect(app).toContain(".menu-item:focus { background: var(--surface-2); outline: none; }");
  });

  it("slides Apply now's fill by transform alone, edged in the field-border grey, with the candidate pages' literal timings", () => {
    expect(rule(cand, ".btn")).toContain("transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease;");
    expect(cand).toContain("@media (prefers-reduced-motion: no-preference) { .btn:active:not(:disabled) { transform: scale(0.97); } }");
    const go = rule(cand, ".btn.go");
    expect(go).toContain("border-color: var(--line-strong);");
    expect(go).toContain("transition: border-color 150ms ease, color 50ms linear 35ms, transform 150ms ease;");
    expect(rule(cand, ".go-fill")).toContain("transform: translateX(calc(-100% - 4px));");
    // placed by the four longhands: older phones' browsers (before Chrome 87, Safari 14.1) skip the `inset` shorthand, and
    // the fill would shrink to nothing while the words still turned light on the pale pill
    expect(rule(cand, ".go-fill")).toContain("position: absolute; top: 4px; right: 4px; bottom: 4px; left: 4px;");
    expect(cand).not.toMatch(/(^|[{;\s])inset\s*:/);
    expect(cand).toContain(".btn.go:focus-visible .go-fill, .btn.go:active .go-fill { transform: none; }");
    expect(cand).toContain("@media (prefers-reduced-motion: no-preference) { .go-fill, .go-icon .icon { transition: transform 200ms ease-out; } }");
    // no unconditional .btn.go:hover: every hover of the pill waits for a mouse
    for (const m of cand.matchAll(/\.btn\.go:hover/g)) expect(insideMedia(cand, m.index ?? 0, HOVER_MEDIA)).toBe(true);
    expect(cand).not.toMatch(/transition:[^;]*width/);
  });
});
