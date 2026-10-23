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
    // the hover variant, the touch targets): 11,173, ceiling unchanged. Round 2 (vertical tabs, option rows, dl.glance,
    // .pill.wrap, IconLabel, wrapping card titles and row titles, the hero card's title): 11,740, ceiling unchanged.
    // Round 3 (the rail breakpoint, PageHeader hero, Card flush and the phone padding of cards, Field aside, Table
    // wrapHeads, IconChip xs, Pill busy, .ordinal, .inline-tag, .list-row-title.wrap): 12,106, ceiling unchanged.
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
      // the kit's own string before a caller's className (round 2): withClass("eyebrow", props.className)
      for (const m of src.matchAll(/\bwithClass\("([^"]+)"/g)) add(m[1]);
    }
    return words;
  };
  /** Words a component writes that need no rule of their own: Tailwind's utility, and IconChip's defaults (the base look). */
  const NO_RULE = new Set(["sr-only", "lavender", "md"]);

  it("styles every class the kit's components render", () => {
    const words = kitClasses();
    expect(words.size).toBeGreaterThan(100);
    for (const w of ["btn", "table-wrap", "th-sort", "tab-label", "stat-cell", "menu-item", "toast-region", "drawer-head", "keep-in-view", "wide", "eyebrow", "icon-label", "chip", "alert"]) expect(words.has(w), w).toBe(true);
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
      ...["xs", "sm", "lg", "peach", "plum", "good", "caution", "neutral"].map((v) => `.icon-chip.${v}`),
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
    // a wide screen: from the frame's rail breakpoint (900px), the same switch as the side rail
    expect(insideMedia(app, sticky, "(width >= theme(--breakpoint-rail))")).toBe(true);
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

  /** Every `@media <query> {` block's body, joined (the phone rules sit in more than one). */
  const mediaBodies = (query: string) => {
    const out: string[] = [];
    for (let at = app.indexOf(`@media ${query} {`); at >= 0; at = app.indexOf(`@media ${query} {`, at + 1)) out.push(mediaBody(app.slice(at), query));
    return out.join("\n");
  };

  // Round 2 (spec 0d, 23 October 2026): fewer words, so the layout carries what the words used to.
  it("lets a card's title and its aside wrap, and sizes the hero card's title itself, only when asked", () => {
    const title = rule(app, ".card-title");
    expect(title).toContain("flex-wrap: wrap;");
    expect(title).toContain("gap: 8px 12px;");
    expect(rule(app, ".card.hero > .card-title h2")).toContain("font-size: 26px;");
    expect(app).toMatch(/@media \(min-width: 768px\) \{\s*\.card\.hero > \.card-title h2 \{ font-size: 30px; \}/);
    // a needs-you card in a side panel or a report is no hero: its title keeps the card's 19px
    expect(rule(app, ".card-title h2")).toContain("font-size: 19px;");
    expect(app).not.toMatch(/\.needs-you[^{}]*\.card-title/);
  });

  it("leaves the kit's tests out of Tailwind's scan, so a word only a test writes adds no utility to the sheet", () => {
    expect(app).toContain('@source ".";\n@source not "*.test.ts";');
  });

  it("shows a row's whole title on a phone instead of cutting it off, and keeps the ellipsis on a desk", () => {
    expect(rule(app, ".list-row-title")).toContain("text-overflow: ellipsis; white-space: nowrap;");
    expect(mediaBodies("(max-width: 640px)")).toMatch(/\.list-row-title \{ white-space: normal; overflow-wrap: anywhere; \}/);
  });

  it("draws an option row round a native radio or checkbox: 44px, tinted when chosen, one ring for the keyboard", () => {
    const row = rule(app, ".option-row");
    for (const d of ["min-height: 44px;", "border: 1px solid var(--line-2);", "border-radius: 12px;", "cursor: pointer;"]) expect(row).toContain(d);
    // only the input counts: a selected <option> or a disabled button elsewhere in the row changes nothing
    expect(rule(app, ".option-row:has(input:checked)")).toBe(" border-color: var(--primary); background: var(--tint); ");
    expect(rule(app, '.option-row:has(input:is([type="radio"], [type="checkbox"]):disabled)')).toContain("opacity: 0.6;");
    // the keyboard's focus rings the row (a mouse's click does not), and the control's own outline steps aside for it
    expect(rule(app, ".option-row:has(input:focus-visible)")).toContain("box-shadow: var(--ring);");
    expect(rule(app, ".option-row:has(input:focus-visible) input:focus-visible")).toBe(" outline: none; ");
    expect(app).not.toMatch(/\.option-row:focus-within/);
    // forced colours drop the ring (a shadow), so the row takes an outline there
    expect(mediaBody(app, "(forced-colors: active)")).toContain(".option-row:has(input:focus-visible) { outline: 2px solid CanvasText; outline-offset: 2px; }");
    // the mouse's edge skips a chosen or disabled row
    const hover = app.indexOf(".option-row:not(:has(input:checked, input:disabled)):hover { border-color: var(--line-strong); }");
    expect(hover).toBeGreaterThan(0);
    expect(insideMedia(app, hover, "(hover: hover) and (pointer: fine)")).toBe(true);
    expect(rule(app, ".option-tag")).toContain("margin-left: auto;");
    expect(selects(app, ".option-row:has(input:checked) .option-tag")).toBe(true);
    // the radio or checkbox itself is never redrawn
    expect(app).not.toMatch(/\.option-row[^{]*input[^{]*\{[^}]*appearance/);
  });

  it("lists facts at a glance as hairline rows of label and value, stacked on a phone", () => {
    expect(rule(app, "dl.glance")).toContain("grid-template-columns: fit-content(40%) minmax(0, 1fr);");
    expect(rule(app, "dl.glance > :is(dt, dd)")).toContain("border-top: 1px solid var(--line);");
    const dt = rule(app, "dl.glance > dt");
    expect(dt).toContain("color: var(--ink-3);");
    expect(dt).toContain("font-size: 13px;");
    const dd = rule(app, "dl.glance > dd");
    expect(dd).toContain("color: var(--ink);");
    expect(dd).toContain("font-size: 15px;");
    expect(mediaBodies("(max-width: 640px)")).toContain("dl.glance { grid-template-columns: minmax(0, 1fr); }");
  });

  it("lets a pill with a long sentence wrap (.pill.wrap) and gives IconLabel its muted mark", () => {
    const wrap = rule(app, ".pill.wrap");
    expect(wrap).toContain("white-space: normal;");
    expect(wrap).toContain("border-radius: 12px;");
    expect(rule(app, ".icon-label")).toContain("color: var(--ink-3);");
  });

  it("runs vertical tabs down the side as an inner nav: 40px rows, the chosen one tinted plum and marked by a bar", () => {
    const V = '.tabs[aria-orientation="vertical"]';
    expect(rule(app, V)).toContain("display: grid;");
    const tab = rule(app, `${V} .tab`);
    expect(tab).toContain("min-height: 40px;");
    expect(tab).toContain("border-radius: 12px;");
    expect(rule(app, `${V} .tab[aria-selected="true"]`)).toBe(" background: var(--tint); color: var(--primary); font-weight: 600; ");
    // never colour alone: the underline becomes a 3px plum bar on the chosen row's left, in every mode
    const bar = rule(app, `${V} .tab::after`);
    for (const d of ["left: 0;", "width: 3px;", "transform: scaleY(0);"]) expect(bar).toContain(d);
    expect(bar).not.toContain("display: none");
    expect(rule(app, `${V} .tab[aria-selected="true"]::after`)).toBe(" transform: none; ");
    expect(rule(app, ".tab::after")).toContain("background: var(--primary);");
    // the mouse's fill waits for a mouse and skips a disabled tab (the check above covers every hover fill; this one is found)
    expect(hoverFills(app).map((f) => f.selector)).toContain(`${V} .tab:not([aria-selected="true"], :disabled):hover`);
    // Windows High Contrast drops the tint: the bar keeps the system highlight
    const forced = mediaBody(app, "(forced-colors: active)");
    expect(forced).toContain('.tab[aria-selected="true"]::after, .tab[aria-current="page"]::after { forced-color-adjust: none; background: Highlight; }');
    expect(forced).not.toMatch(/\.tab[^{}]*::after \{[^}]*display: none/);
    // the tabs across keep their underline
    expect(rule(app, '.tab[aria-selected="true"]::after, .tab[aria-current="page"]::after')).toBe(" transform: scaleX(1); ");
  });

  // Round 3 (23 October 2026): the small options screens had copied around, so the next screen reaches for the kit's.
  it("names the frame's 900px switch as a breakpoint (rail:), in rem so it sorts between md and lg, and the kit's 900px queries read it", () => {
    const theme = rule(app, "@theme inline");
    expect(theme).toContain("--breakpoint-rail: 56.25rem;");
    expect(56.25 * 16).toBe(900);
    // Tailwind's own sm, md (48rem) and lg (64rem) are kept, so rail: falls between md: and lg: in the sheet
    expect(theme).not.toContain("--breakpoint-*");
    // no pixel copy of the switch is left in the kit: the table's own scrolling box and the split view read the theme
    expect(app).not.toMatch(/\b(899|900|901)px\b/);
    expect(insideMedia(app, app.indexOf(".table-wrap.scroll {"), "(width >= theme(--breakpoint-rail))")).toBe(true);
    expect(insideMedia(app, app.indexOf(".split-switch { display: inline-flex;"), "(width < theme(--breakpoint-rail))")).toBe(true);
  });

  it("draws PageHeader's hero title at Home's greeting size (36, 44 from 640px, 52 from 768px), the plain title as before", () => {
    expect(rule(app, ".page-header.hero .page-header-row h1")).toBe(" font-size: 36px; ");
    expect(mediaBodies("(min-width: 640px)")).toContain(".page-header.hero .page-header-row h1 { font-size: 44px; }");
    const wide = mediaBodies("(min-width: 768px)");
    expect(wide).toContain(".page-header.hero .page-header-row h1 { font-size: 52px; }");
    // after the plain title's 40px in the same block, so the hero's size wins there
    expect(wide.indexOf(".page-header.hero .page-header-row h1")).toBeGreaterThan(wide.indexOf(".page-header-row h1 { font-size: 40px; }"));
    expect(rule(app, ".page-header-row h1")).toContain("font-size: 34px;");
  });

  it("pads every card 16px at the sides and 20px above and below on a phone, and runs a list card's (flush) rows edge to edge", () => {
    expect(rule(app, ".card")).toContain("padding: 24px;");
    const phone = mediaBodies("(max-width: 640px)");
    // :not(.flush) outranks .card.needs-you's 28px and leaves the list card at 0
    expect(phone).toContain(".card:not(.flush) { padding: 20px 16px; }");
    expect(rule(app, ".card.flush")).toBe(" padding: 0; ");
    const title = rule(app, ".card.flush > .card-title");
    for (const d of ["margin: 0;", "padding: 16px 24px;", "border-bottom: 1px solid var(--line);"]) expect(title).toContain(d);
    expect(rule(app, ".card.flush :is(.list-row, .list-item)")).toBe(" padding-inline: 24px; ");
    expect(phone).toContain(".card.flush > .card-title, .card.flush :is(.list-row, .list-item) { padding-inline: 16px; }");
    // nothing is clipped (a row's menu opens over what lies below): the end rows take the card's corners instead
    expect(app).not.toMatch(/\.card\.flush[^{]*\{[^}]*overflow/);
    expect(rule(app, ".card.flush > :last-child, .card.flush > :is(ul, ol):last-child > :last-child")).toContain("border-bottom-left-radius: 15px;");
    // and it comes after the needs-you wash, so a needs-you list card is flush too
    expect(app.indexOf(".card.flush {")).toBeGreaterThan(app.indexOf(".card.needs-you {"));
  });

  it("draws the small marks screens used to copy: the numbered circle, the inline tag, a row title that wraps, an IconLabel by a card's title", () => {
    const ordinal = rule(app, ".ordinal");
    for (const d of ["width: 24px; height: 24px;", "border-radius: 9999px;", "background: var(--tint-2);", "color: var(--primary);", "font-family: var(--font-mono); font-size: 11px;"]) expect(ordinal).toContain(d);
    // Tailwind's `ordinal` utility (font-variant-numeric) would beat the kit's rule: switched off, like list-item
    expect(app).toContain('@source not inline("ordinal");');
    const tag = rule(app, ".inline-tag");
    for (const d of ["background: var(--tint-2);", "color: var(--primary);", "font-family: var(--font-mono); font-size: 11px;", "white-space: nowrap;"]) expect(tag).toContain(d);
    // a row title that must be whole wraps at every width, not only on a phone
    expect(rule(app, ".list-row-title.wrap")).toBe(" white-space: normal; overflow-wrap: anywhere; ");
    expect(app.indexOf(".list-row-title.wrap {")).toBeLessThan(app.indexOf("@media (max-width: 640px) {"));
    expect(rule(app, ".card-title > .icon-label")).toBe(" align-self: center; ");
  });

  it("styles the other round-3 options: IconChip xs, Pill busy, Field aside, Table wrapHeads, an Eyebrow that is a heading", () => {
    expect(rule(app, ".icon-chip.xs")).toContain("width: 28px; height: 28px;");
    expect(rule(app, ".pill > .spinner")).toContain("width: 12px; height: 12px;");
    expect(rule(app, ".field-head")).toContain("align-items: center;");
    expect(selects(app, ".field-head > label")).toBe(true);
    // a figure column's heading too (`.table .num` keeps figures on one line)
    expect(rule(app, ".table-wrap.wrap-heads thead th")).toBe(" white-space: normal; ");
    expect(rule(app, ".eyebrow:is(h2, h3)")).toContain("font-size: 11px;");
    // it must come after the card's and the side card's own heading sizes, which share its specificity
    for (const sel of [".card-title h2 {", ".side-card > :is(h2, h3) {", ".section-header h3 {"]) expect(app.indexOf(".eyebrow:is(h2, h3) {"), sel).toBeGreaterThan(app.indexOf(sel));
  });
});

/**
 * The candidate pages' stylesheet (apps/api/src/pages/layout.tsx; redesigned in October 2026 with the application's
 * palette) keeps the rules it was written under: 200ms, no loop of its own, one short entrance, the literal
 * reduced-motion rule, hovers behind (hover: hover) and (pointer: fine).
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
    // the guard finds what it guards: the page's one entrance, a 200ms rise that fills nothing after it ends, and not on
    // a page that comes back after each answer or wait (a chat thread, the waiting room, the reading page)
    expect(names.has("rise")).toBe(true);
    expect(cand).toContain("main:not(:has(.thread, .wait, .reading)) { animation: rise 200ms ease-out backwards; }");
    expect(cand).not.toMatch(/main \{[^}]*animation/);
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
    // 23 October 2026, the candidate pages' redesign: 5,100 raised to 5,500 (+400). The application's palette needs more
    // tokens copied in both themes (30 colours and shadows, 21 before: the lavender and peach tints, the glow, the plum
    // focus and shadows), and the pages gained the careers rows, the file's drop area and the "next step" status wash.
    // Measured at 5,481 (after the review's fixes).
    expect(gzipSync(Buffer.from(candidate), { level: 9 }).length).toBeLessThanOrEqual(5_500);
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
