/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * What keeps the product light on old laptops and phones (docs/07; the October 2026 redesign): only the chosen styling
 * and animation libraries (Tailwind CSS, PostCSS, motion, clsx, tailwind-merge) and no component, icon, chart or other
 * animation library; motion on transform and opacity only, 320ms or less except the four named loops; nothing blurred;
 * presses only when motion is welcome; hover fills only where there is a mouse; reduced motion stops everything,
 * pseudo-elements included; and the stylesheet stays within its byte budget. Raising a budget is a deliberate edit to
 * this file, with the reason in the commit.
 */
const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8").replace(/\r\n/g, "\n");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** The application's one stylesheet (Tailwind builds the rest from the classes the pages use). */
const styles = read("packages/ui/src/styles.css");
const app = strip(styles);
const layout = read("apps/api/src/pages/layout.tsx");
const from = layout.indexOf("export const CSS = `") + "export const CSS = `".length;
/** The candidate pages' inline stylesheet as it ships (comments included: nothing minifies it), without the font faces. */
const candidate = layout.slice(from, layout.indexOf("`;", from)).replace(/\$\{fontFaceCss\(\)\}/, "");

/** Every literal duration in a value, in milliseconds. */
const durations = (value: string) => [...value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map((d) => (d[2] === "s" ? Number(d[1]) * 1000 : Number(d[1])));
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
/** The body of the first `@media <query> {` block, found by matching braces. */
function mediaBody(css: string, query: string): string {
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
/** Every rule that fills a background on :hover, and where it starts (a fill left behind by a tap on a phone shows). */
function hoverFills(css: string): Array<{ selector: string; at: number }> {
  return [...css.matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/g)].filter((m) => /(?:^|[;\s])background(?:-color)?\s*:/.test(m[2])).map((m) => ({ selector: m[1].trim(), at: m.index ?? 0 }));
}
const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.search(new RegExp(`(^|[\\n{}])\\s*${escape(selector)} \\{`));
  expect(at, `no ${selector} rule`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", css.indexOf(selector, at));
  return css.slice(open + 1, css.indexOf("}", open));
}
/** Whether `selector` (a class, or a compound such as `.btn.primary`) is part of some rule's selector, not a value. */
function selects(css: string, selector: string): boolean {
  for (const m of css.matchAll(new RegExp(`${escape(selector)}(?![\\w-])`, "g"))) {
    const after = css.slice((m.index ?? 0) + m[0].length);
    const brace = after.search(/[{}]/);
    if (brace >= 0 && after[brace] === "{" && !after.slice(0, brace).includes(";")) return true;
  }
  return false;
}

describe("nothing heavier on old devices", () => {
  it("lists only the chosen styling and animation libraries, and no component, icon or chart library, in any package", () => {
    const FORBIDDEN = /^(gsap|three|postprocessing|@react-three\/.+|framer-motion|@radix-ui\/.+|@base-ui\/.+|@base-ui-components\/.+|lucide-react|@lucide\/.+|lenis|@studio-freight\/lenis|recharts|@number-flow\/react|@paper-design\/shaders-react|vaul|sonner|class-variance-authority|tw-animate-css)$/;
    // anything that styles or animates must be one of these (Tailwind CSS through PostCSS, motion, and the class joiners)
    const STYLING = /tailwind|^tw-|motion|animat|spring|gsap|lottie|styled|emotion|stitches|vanilla-extract|clsx|classnames|class-variance|lucide|heroicons|radix|base-ui|headlessui|chakra|mantine|^@mui\/|framer|lenis|recharts|number-flow|^vaul$|^sonner$|postcss|^sass$/;
    const ALLOWED = new Set(["tailwindcss", "@tailwindcss/postcss", "postcss", "motion", "clsx", "tailwind-merge"]);
    const files = ["package.json", ...["apps", "packages"].flatMap((dir) => readdirSync(new URL(`${dir}/`, repo)).map((name) => `${dir}/${name}/package.json`))].filter((f) => existsSync(new URL(f, repo)));
    expect(files.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    for (const file of files) {
      const pkg = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          expect(name, `${file} ${field}`).not.toMatch(FORBIDDEN);
          if (STYLING.test(name)) {
            expect(ALLOWED.has(name), `${file} ${field}: ${name} is not one of the chosen styling libraries`).toBe(true);
            seen.add(name);
          }
        }
      }
    }
    // the guard finds what it guards: the stack is there
    for (const name of ["tailwindcss", "motion"]) expect(seen.has(name), name).toBe(true);
  });
});

/** The application's stylesheet: packages/ui/src/styles.css (tokens, base, the kit's component layer). */
describe("the application's stylesheet", () => {
  /** Endless animations allowed: the skeleton's shimmer, the Live ring, the typing dots and the spinner. */
  const LOOPS = new Set(["shimmer", "live", "typing", "spin"]);
  const MAX_MS = 320;
  // a mouse: some phones report (hover: hover), and a tapped control must never stay filled (the candidate pages' rule too)
  const HOVER = "(hover: hover) and (pointer: fine)";
  const MOTION_OK = "(prefers-reduced-motion: no-preference)";

  it("blurs nothing (backdrop-filter and blur are slow on cheap devices)", () => {
    expect(app).not.toMatch(/backdrop-filter|blur\(/);
    // and Tailwind's blur utilities are switched off
    expect(app).toContain("--blur-*: initial;");
  });

  it("animates only transform and opacity, and loops only the shimmer, the live ring, the typing dots and the spinner", () => {
    const frames = keyframes(app);
    expect(frames.length).toBeGreaterThan(5);
    const names = new Set(frames.map((k) => k.name));
    for (const k of frames) for (const p of k.props) expect(p, `@keyframes ${k.name}`).toMatch(/^(transform|opacity)$/);
    // the animation declarations, and the theme's animate-* classes (Tailwind's own looping ones are switched off)
    expect(app).toContain("--animate-*: initial;");
    const values = [...app.matchAll(/(?:^|[;{\s])(?:animation|--animate-[a-z-]+):\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(10);
    for (const v of values) {
      if (v.startsWith("none")) continue;
      const name = v.split(/\s+/).find((w) => names.has(w));
      expect(name, `animation ${v} names no keyframes here`).toBeDefined();
      if (/\binfinite\b/.test(v)) expect(LOOPS.has(name ?? ""), `endless animation ${v}`).toBe(true);
      else for (const d of durations(v)) expect(d, `animation ${v}`).toBeLessThanOrEqual(MAX_MS);
    }
  });

  it(`keeps every transition to ${MAX_MS}ms or less, with its duration written out, on nothing that moves the layout`, () => {
    const values = [...app.matchAll(/transition(?:-duration)?:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(values.length).toBeGreaterThan(10);
    for (const v of values) {
      if (v.startsWith("none")) continue;
      const ds = durations(v);
      expect(ds.length, `transition ${v}`).toBeGreaterThan(0);
      for (const d of ds) expect(d, `transition ${v}`).toBeLessThanOrEqual(MAX_MS);
      expect(v, "a transition on layout").not.toMatch(/\b(all|width|height|top|left|right|bottom|margin|padding|inset)\b/);
    }
  });

  it("stops every transition and animation for reduced motion, pseudo-elements included", () => {
    const reduce = mediaBody(app, "(prefers-reduced-motion: reduce)");
    expect(reduce).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
    expect(reduce).toMatch(/animation(?:-duration)?:\s*(?:none|0s|0ms|0\.01ms)\s*!important/);
    expect(reduce).toMatch(/transition(?:-duration)?:\s*(?:none|0s|0ms|0\.01ms)\s*!important/);
    // an endless animation ends after its one short run
    expect(reduce).toMatch(/animation-iteration-count:\s*1\s*!important|animation:\s*none\s*!important/);
    // and nothing waits: a staggered entrance would sit invisible for its delay and then pop in
    expect(reduce).toMatch(/animation-delay:\s*0m?s\s*!important/);
    expect(reduce).toMatch(/transition-delay:\s*0m?s\s*!important/);
  });

  it("presses (a transform on :active) and nudges (a transform on :hover, under a mouse) only when motion is welcome", () => {
    const presses = [...app.matchAll(/[^{}]*:active[^{}]*\{[^}]*transform:(?!\s*none)/g)];
    expect(presses.length).toBeGreaterThan(0);
    for (const m of presses) expect(insideMedia(app, m.index ?? 0, MOTION_OK), m[0].trim()).toBe(true);
    for (const m of app.matchAll(/[^{}]*:hover[^{}]*\{[^}]*transform:(?!\s*none)/g)) expect(insideMedia(app, m.index ?? 0, `${HOVER} and ${MOTION_OK}`), m[0].trim()).toBe(true);
  });

  it("fills a background on hover only where there is a mouse, Tailwind's hover: classes included", () => {
    for (const f of hoverFills(app)) expect(insideMedia(app, f.at, HOVER), f.selector).toBe(true);
    // the pages' hover: utilities wait for the same mouse
    expect(app).toMatch(/@custom-variant hover \{\s*@media \(hover: hover\) and \(pointer: fine\) \{\s*&:hover \{\s*@slot;/);
  });

  it("finds what it guards, and would catch a slip", () => {
    // the hover fills it checks are there, so the check above cannot pass by finding none
    const found = hoverFills(app).map((f) => f.selector);
    for (const sel of [".btn.primary:hover", ".icon-btn:hover", ".menu-item:hover", ".table tbody tr:hover > :is(td, th):not(.table-empty)", "a.stat-cell:hover"]) expect(found).toContain(sel);
    // a new ungated hover fill, a keyframe on anything but transform and opacity, a press outside the motion query
    const probe = `${app}\n.probe:hover { background: red; }`;
    expect(hoverFills(probe).filter((f) => !insideMedia(probe, f.at, HOVER)).map((f) => f.selector)).toEqual([".probe:hover"]);
    for (const prop of ["background-color", "color", "border-color", "width"]) expect(keyframes(`@keyframes probe { to { ${prop}: red; } }`)[0].props).toEqual([prop]);
    const press = `${app}\n.probe:active { transform: scale(0.9); }`;
    expect(insideMedia(press, press.lastIndexOf(".probe:active"), MOTION_OK)).toBe(false);
  });

  it("moves the live ring, never the dot, and fades the skeleton on the pressed grey instead of sliding it", () => {
    expect(app).not.toMatch(/\.dot\.pulse \{[^}]*animation/);
    expect(app).toMatch(/\.dot\.pulse::after \{[^}]*animation: live /);
    expect(app).toMatch(/\.skeleton \{[^}]*background: var\(--surface-3\);[^}]*animation: shimmer /);
    expect(app).not.toMatch(/\.skeleton \{[^}]*gradient/);
  });

  it("keeps the stylesheet within its byte budget (gzip level 9, without comments)", () => {
    const gz = (s: string) => gzipSync(Buffer.from(s), { level: 9 }).length;
    // 23 October 2026, the redesign's foundation: tokens, base and the whole kit in one sheet, 10,723 bytes (it replaces
    // tokens.css, board.css and app-shell.css, whose ceilings were 12,000 + 2,350 + 820; the screens' own styling is
    // Tailwind utilities, built from the classes they use). After the review fixes (the alerts' marks as data: images,
    // the hover variant, the touch targets): 11,173, ceiling unchanged.
    expect(gz(app)).toBeLessThanOrEqual(12_500);
  });
});

/** The kit's look and behaviour promises, read back from styles.css (docs/07; the guards kept from before the redesign). */
describe("the kit's component layer", () => {
  /** Every class word the kit's components write in a className (literal strings, cx() arguments, templates). */
  const kitClasses = () => {
    const dir = new URL("./", import.meta.url);
    const words = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(new URL(file, dir), "utf8");
      const add = (s: string) => {
        for (const w of s.split(/\s+/)) if (w) words.add(w);
      };
      for (const m of src.matchAll(/className="([^"]+)"/g)) add(m[1]);
      for (const m of src.matchAll(/className=\{`([^`]+)`\}/g)) add(m[1].replace(/\$\{[^}]*\}/g, " "));
      for (const m of src.matchAll(/\bcx\(([^)]*)\)/g)) for (const s of m[1].matchAll(/"([^"]+)"/g)) add(s[1]);
      for (const m of src.matchAll(/className=\{[^}]*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g)) add(`${m[1]} ${m[2]}`);
    }
    return words;
  };
  /** Words a component writes that need no rule of their own: Tailwind's utility, and IconChip's defaults (the base look). */
  const NO_RULE = new Set(["sr-only", "lavender", "md"]);

  it("styles every class the kit's components render", () => {
    const words = kitClasses();
    expect(words.size).toBeGreaterThan(100);
    for (const w of ["btn", "table-wrap", "th-sort", "tab-label", "stat-cell", "menu-item", "toast-region", "drawer-head", "keep-in-view", "wide"]) expect(words.has(w), w).toBe(true);
    for (const w of words) if (!NO_RULE.has(w)) expect(selects(app, `.${w}`), `.${w} has no rule in styles.css`).toBe(true);
    // the variants chosen by a prop (a tone, a size), which the scan above cannot see as literals
    const variants = [
      ...["primary", "secondary", "ghost", "quiet", "danger", "destructive", "sm", "wide"].map((v) => `.btn.${v}`),
      ...["accent", "needs", "good", "caution", "critical", "info", "warm", "source"].map((v) => `.chip.${v}`),
      ...["good", "caution", "critical", "accent", "info", "warm"].map((v) => `:is(.pill, .pill-button).${v}`),
      ...["good", "caution", "critical", "accent", "info", "warm"].map((v) => `.dot.${v}`),
      ...["good", "caution", "neutral", "none", "sm", "lg"].map((v) => `.score.${v}`),
      ...["sm", "lg", "xl", "ink", "square"].map((v) => `.avatar.${v}`),
      ...["info", "caution", "critical"].map((v) => `.alert.${v}`),
      ...["assistant", "user", "system", "recruiter", "typing", "answers"].map((v) => `.bubble.${v}`),
      ...["sm", "lg", "peach", "plum", "good", "caution", "neutral"].map((v) => `.icon-chip.${v}`),
      ...["done", "active", "failed"].map((v) => `.steps li[data-state="${v}"]`),
      ".pill.sm", ".pill.solid", ".icon-btn.sm", ".toast.good", ".toast.critical", ".toast.has-action", ".sheet.lg", ".dialog.lg", ".dialog-mark.good", ".menu-item.danger", ".tabs.counts", ".stat-cell.highlight", ".table-wrap.scroll", ".table-wrap.pin-first", ".table th.num .th-sort", ".table .skeleton", ".dot.pulse::after",
    ];
    for (const sel of variants) expect(selects(app, sel), `${sel} has no rule`).toBe(true);
  });

  it("styles the shared primitives the screens combine with utilities (spec 0b.3 and 5b)", () => {
    for (const sel of [".stack", ".row", ".muted", ".small", ".grid-2", ".kv", "details.more > summary", ".link-btn", ".link-like", ".tabular", ".num", ".list", ".list-item", ".list-item-main", ".list-item-main .sub", ".list-item-end", ".setup-section", ".input", ".textarea", ".select", ".field", ".hint", ".field-error", ".check", ".dropzone", ".toggle-chip", ".toggle-chip .count", ".segmented", ".spinner", ".skeleton", ".kbd", ".dot.pulse", ".side-card", ".list-card", ".list-row", ".list-row-lead", ".list-row-main", ".list-row-title", ".list-row-meta", ".list-row-end", ".chev", ".text-link", ".eyebrow.live::before", ".page-header", ".page-header-row", ".page-header-actions", ".page-header-sub", ".section-header", ".icon-chip", ".stat-strip", ".stat-cell", ".bubble-label", ".composer", ".composer-send", ".suggestion", ".card.needs-you", ".card.lift", ".autogrow", ".timeline .when", ".pipeline"]) {
      expect(selects(app, sel), `${sel} has no rule`).toBe(true);
    }
    // the older rows' trailing chevron answers the row's hover like .chev does
    expect(app).toMatch(/:is\(\.list-item, \.list-row\):hover :is\(\.chev, \.list-item-end > \.icon:last-child\)/);
  });

  it("keeps the menu's keyboard fill on every device; only the pointer's fill waits for a mouse", () => {
    expect(rule(app, ".menu-item:focus")).toBe(" background: var(--tint); outline: none; ");
    expect(rule(app, ".menu-item:focus-visible")).toContain("box-shadow: inset 0 0 0 2px var(--focus);");
    const at = app.indexOf(".menu-item:focus {");
    for (const query of ["(hover: hover)", "(hover: hover) and (pointer: fine)", "(pointer: fine)"]) expect(insideMedia(app, at, query), query).toBe(false);
    expect(insideMedia(app, app.indexOf(".menu-item:hover {"), "(hover: hover) and (pointer: fine)")).toBe(true);
  });

  it("keeps a tab's label the width of its bold self, the copy hidden from screen readers", () => {
    expect(rule(app, ".tab-label")).toContain("flex-direction: column;");
    expect(rule(app, ".tab-label::after")).toBe(" content: attr(data-label); height: 0; overflow: hidden; visibility: hidden; font-weight: 600; pointer-events: none; user-select: none; ");
    expect(rule(app, '.tab[aria-selected="true"], .tab[aria-current="page"]')).toContain("font-weight: 600;");
  });

  it("draws tables like screenshot 4: mono headings in the muted ink, rows at least 64px, a tint under the mouse", () => {
    const head = rule(app, ".table thead th");
    for (const d of ["color: var(--ink-3);", "font-family: var(--font-mono); font-size: 11px;", "text-transform: uppercase;", "text-align: left;"]) expect(head).toContain(d);
    expect(rule(app, ".table tbody tr")).toContain("height: 64px;");
    expect(rule(app, ".table .num")).toContain("text-align: right;");
    expect(rule(app, ".table tbody tr:hover > :is(td, th):not(.table-empty)")).toContain("background:");
    // the scrollbar's thumb is the field-border grey (3:1 or more on the surface), not a hairline
    expect(rule(app, ".table-wrap")).toContain("scrollbar-color: var(--line-strong) transparent;");
  });

  it("keeps headings and the first column in view on solid fills, sticky headings only on a wide screen", () => {
    const sticky = app.indexOf(".table-wrap.scroll thead th {");
    expect(sticky).toBeGreaterThan(0);
    expect(insideMedia(app, sticky, "(min-width: 901px)")).toBe(true);
    expect(rule(app, ".table-wrap.scroll thead th")).toContain("position: sticky; top: 0;");
    expect(rule(app, ".table-wrap.pin-first :is(th, td):first-child")).toContain("position: sticky; left: 0;");
    expect(rule(app, ".table-wrap.pin-first tbody :is(th, td):first-child")).toContain("background: var(--surface);");
  });

  it("keeps a sorting heading's words on the plain headings' line, and the no-rows words in view on a phone", () => {
    // top-aligned: on its baseline a figure column's button (arrows first, row-reverse) stands higher than the words beside it
    expect(rule(app, ".th-sort")).toContain("vertical-align: top;");
    expect(rule(app, ".table th.num .th-sort")).toContain("flex-direction: row-reverse;");
    // the no-rows cell spans every column, so centred words would sit mid-table, off the edge of a phone's box
    expect(rule(app, ".table td.table-empty")).toContain("text-align: left;");
    expect(rule(app, ".table td.table-empty")).not.toContain("center");
    // nor is it pinned with the first column (no stray divider at the far edge); it undoes that rule, so it comes after it
    expect(rule(app, ".table-wrap.pin-first td.table-empty")).toBe(" position: static; box-shadow: none; ");
    expect(app.indexOf(".table-wrap.pin-first td.table-empty {")).toBeGreaterThan(app.indexOf(".table-wrap.pin-first :is(th, td):first-child {"));
  });

  it("gives every small control a 40px target on a touch screen", () => {
    const coarse = mediaBody(app, "(pointer: coarse)");
    for (const sel of [".btn.sm", ".pill-button", ".toggle-chip", ".segmented button", ".suggestion", ".toast-action", ".menu-item", ".th-sort", "details.more > summary", ".sbars-more > summary"]) expect(selects(coarse, sel), sel).toBe(true);
    expect(coarse).toMatch(/\.icon-btn, \.icon-btn\.sm \{ width: 40px; height: 40px; \}/);
  });

  it("marks a link in running text by more than its colour, and an alert's tone by a mark as well as its fill", () => {
    // plum and semibold, with an underline at rest: a link inside bold words still shows (WCAG 1.4.1)
    expect(rule(app, ':where(main) :is(a:not([class]), a[class="small"])')).toContain("text-decoration-line: underline;");
    expect(rule(app, ".alert::before")).toMatch(/background: currentColor;[\s\S]*mask: var\(--alert-mark\)/);
    for (const tone of ["caution", "critical"]) expect(rule(app, `.alert.${tone}`)).toContain('--alert-mark: url("data:image/svg+xml,');
    expect(rule(app, ".alert")).toContain('--alert-mark: url("data:image/svg+xml,');
    // under forced colours the mark keeps the text colour instead of vanishing with the backgrounds
    expect(mediaBody(app, "(forced-colors: active)")).toContain(".alert::before { forced-color-adjust: none; background: CanvasText; }");
  });
});

/**
 * The candidate pages' stylesheet (apps/api/src/pages/layout.tsx) keeps the rules it was written under until those pages
 * are redesigned: 200ms, its own loops, the literal reduced-motion rule, hovers behind (hover: hover) and (pointer: fine).
 */
describe("the candidate pages' stylesheet", () => {
  const cand = strip(candidate);
  const HOVER_MEDIA = "(hover: hover) and (pointer: fine)";
  const LOOPS = new Set(["skeleton-pulse", "live-ping", "spin", "dot-bounce"]);
  const OLDER_ONE_OFFS = new Set(["draft-flash"]);
  /** The declarations of the first rule whose selector is exactly `selector`. */
  const rule = (css: string, selector: string) => {
    const at = css.search(new RegExp(`(^|[\\n{}])\\s*${selector.replace(/[.*+?^$()|[\]\\]/g, "\\$&")} \\{`));
    expect(at, `no ${selector} rule`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", css.indexOf(selector, at));
    return css.slice(open + 1, css.indexOf("}", open));
  };

  it("blurs nothing", () => {
    expect(cand).not.toMatch(/backdrop-filter|filter:\s*blur\(/);
  });

  it("animates only transform and opacity, and loops only the loading fade, the live ring, the spinner and the typing dots", () => {
    const names = new Set<string>();
    for (const k of keyframes(cand)) {
      names.add(k.name);
      if (OLDER_ONE_OFFS.has(k.name)) continue;
      for (const p of k.props) expect(p, `@keyframes ${k.name}`).toMatch(/^(transform|opacity)$/);
    }
    for (const m of cand.matchAll(/animation:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (v.startsWith("none")) continue;
      const name = v.split(/\s+/).find((w) => names.has(w)) ?? v;
      if (/\binfinite\b/.test(v)) expect(LOOPS.has(name), `endless animation ${name}`).toBe(true);
      else if (!OLDER_ONE_OFFS.has(name)) for (const d of durations(v)) expect(d, `animation ${v}`).toBeLessThanOrEqual(200);
    }
  });

  it("keeps every transition to 200ms or less, on nothing that moves the layout", () => {
    for (const m of cand.matchAll(/transition(?:-duration)?:\s*([^;}]+)/g)) {
      if (m[1].trim().startsWith("none")) continue;
      for (const d of durations(m[1])) expect(d, `transition ${m[1]}`).toBeLessThanOrEqual(200);
      expect(m[1]).not.toMatch(/\b(width|height|box-shadow|top|left|margin|padding)\b/);
    }
  });

  it("stops every transition and animation for reduced motion, pseudo-elements included", () => {
    expect(cand).toContain("@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }");
  });

  it("presses (a transform on :active) only when motion is welcome", () => {
    for (const m of cand.matchAll(/[^{}]*:active[^{}]*\{[^}]*transform:(?!\s*none)/g)) expect(insideMedia(cand, m.index ?? 0, "(prefers-reduced-motion: no-preference)"), m[0].trim()).toBe(true);
  });

  it("fills a background on hover, or slides the arrow pill's fill, only where there is a mouse", () => {
    for (const f of hoverFills(cand)) expect(insideMedia(cand, f.at, HOVER_MEDIA), f.selector).toBe(true);
    for (const m of cand.matchAll(/\.btn\.go:hover \.go-fill/g)) expect(insideMedia(cand, m.index ?? 0, HOVER_MEDIA), m[0]).toBe(true);
    // the guard finds the fills it checks
    for (const sel of [".btn:hover", ".btn.secondary:hover", "input[type=file]::file-selector-button:hover"]) expect(hoverFills(cand).map((f) => f.selector)).toContain(sel);
    expect(cand).toContain(".btn.go:hover .go-fill");
  });

  it("stays within its byte budget (gzip level 9, with comments, as it ships)", () => {
    expect(gzipSync(Buffer.from(candidate), { level: 9 }).length).toBeLessThanOrEqual(5_100);
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
