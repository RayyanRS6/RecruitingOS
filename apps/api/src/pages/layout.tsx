/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { getContext } from "hono/context-storage";
import type { Vars } from "../middleware/session";
import { APP_FONTS, fontFaceCss } from "./fonts";

/** The nonce the policy middleware issued for this request; empty outside a request (unit renders). */
export function currentNonce(): string {
  try { return getContext<Vars>().get("nonce") ?? ""; } catch { return ""; }
}

/** IBM Plex Mono 400, the eyebrows' face: a file the application already serves from /fonts/ (fonts.ts, APP_FONTS). */
const MONO_FONTS = APP_FONTS.filter((f) => f.family === "IBM Plex Mono");

/**
 * Candidate-facing pages are server-rendered, mobile-first, and need no JavaScript. They wear the application's look
 * (docs/07, the October 2026 redesign): a warm paper ground with a soft peach and lavender glow, a white sheet for the
 * page's content, plum pill buttons, outlined secondary ones, small mono uppercase eyebrows, display headings, and
 * lavender notice boxes. The token values below are copied from packages/ui/src/styles.css (this page cannot import a
 * stylesheet; candidate-look.test.ts fails if the two drift), and the fonts come from this deployment's own origin
 * (fonts.ts), so the content-security policy needs no outside host.
 */
export const CSS = `
${fontFaceCss()}
${fontFaceCss(MONO_FONTS)}
:root {
  --ground: #faf7f5;
  --surface: #fefcfb;
  --surface-2: #f6f1ee;
  --tint: #f5eff5;
  --tint-2: #ece4f1;
  --peach: #fbe7e0;
  --glow-1: rgb(237 143 120 / 0.11);
  --glow-2: rgb(150 110 185 / 0.08);
  --line: #e6ded7;
  --line-2: #d9cec6;
  --line-tint: #ded4e5;
  --line-strong: #8f8395;
  --ink: #2f2239;
  --ink-2: #65596e;
  --ink-3: #6f6376;
  --primary: #523267;
  --primary-hover: #432853;
  --on-primary: #fdfbf8;
  --focus: #7a4e98;
  --accent: #db5533;
  --accent-ink: #a8401f;
  --accent-soft: #fbe7e0;
  --good: #48644f;
  --caution: #85522a;
  --caution-soft: #fbefe4;
  --critical: #a33a2c;
  --critical-soft: #fbeae7;
  --sh-xs: 0 1px 2px rgb(47 34 57 / 0.04);
  --sh-pop: 0 18px 44px -14px rgb(47 34 57 / 0.3), 0 2px 6px rgb(47 34 57 / 0.06);
  --sh-primary: 0 8px 20px -10px rgb(82 50 103 / 0.6);
  --display: "Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif;
  --ui: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", Menlo, Consolas, monospace;
  --r-control: 12px;
  --r-card: 16px;
  --r-panel: 20px;
  --r-pill: 9999px;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #141016;
    --surface: #1c1720;
    --surface-2: #231d28;
    --tint: #2c2233;
    --tint-2: #35293d;
    --peach: #3a2622;
    --glow-1: rgb(240 138 108 / 0.06);
    --glow-2: rgb(170 130 210 / 0.07);
    --line: #2f2734;
    --line-2: #41364a;
    --line-tint: #4a3b56;
    --line-strong: #8a7d92;
    --ink: #f3eef5;
    --ink-2: #c3b7ca;
    --ink-3: #a497ab;
    --primary: #cdb0e2;
    --primary-hover: #dcc5ec;
    --on-primary: #1e1426;
    --focus: #cdb0e2;
    --accent: #f08a6c;
    --accent-ink: #f4a68e;
    --accent-soft: #3a2622;
    --good: #9cc6a3;
    --caution: #e9bc90;
    --caution-soft: #33271d;
    --critical: #ff9f92;
    --critical-soft: #3a2020;
    --sh-xs: 0 1px 2px rgb(0 0 0 / 0.35);
    --sh-pop: 0 20px 48px -12px rgb(0 0 0 / 0.75), 0 2px 6px rgb(0 0 0 / 0.4);
    --sh-primary: 0 8px 22px -10px rgb(0 0 0 / 0.7);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background-color: var(--ground); background-image: radial-gradient(60rem 36rem at 100% -6rem, var(--glow-1), transparent 70%), radial-gradient(48rem 30rem at 38% -10rem, var(--glow-2), transparent 70%); background-repeat: no-repeat; color: var(--ink); font: 16px/1.55 var(--ui); -webkit-font-smoothing: antialiased; }
main { width: min(680px, calc(100% - 32px)); margin: 40px auto 64px; padding: 40px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); box-shadow: var(--sh-xs); }
main.wide { width: auto; max-width: 1120px; margin: 0 auto; padding: 48px 24px 80px; background: none; border: 0; border-radius: 0; box-shadow: none; }
/* The page rises in, unless it comes back after each answer */
main:not(:has(.thread, .wait, .reading)) { animation: rise 200ms ease-out backwards; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
h1, h2, h3 { color: var(--ink); font-family: var(--display); font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; overflow-wrap: anywhere; }
h1 { margin: 0 0 10px; font-size: 34px; line-height: 1.08; letter-spacing: -0.035em; }
h2 { margin: 36px 0 12px; font-size: 21px; line-height: 1.25; }
h3 { margin: 24px 0 8px; font-size: 17px; line-height: 1.35; letter-spacing: -0.01em; }
.card > h2:first-child, .card > label:first-child { margin-top: 0; }
p { margin: 0 0 12px; color: var(--ink-2); }
p:last-child { margin-bottom: 0; }
strong { color: var(--ink); font-weight: 600; }
a { color: var(--primary); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
small { color: var(--ink-3); font-size: 13.5px; }
code { font-family: var(--mono); font-size: 15px; letter-spacing: 0.04em; }
img { max-width: 100%; height: auto; }
::selection { background: var(--tint-2); color: var(--ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.icon { flex: none; width: 16px; height: 16px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
/* A field only bots fill in */
.trap { position: absolute; left: -10000px; }

/* Heads: a mono eyebrow, a back link, a lead */
.eyebrow { margin: 0 0 14px; color: var(--ink-2); font: 400 11.5px/1.5 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; }
.eyebrow a { color: inherit; }
.back { margin: 0 0 16px; font-size: 14.5px; }
.back a { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; color: var(--ink-2); font-weight: 600; text-decoration: none; }
.back a:hover { color: var(--ink); text-decoration: underline; }
.lead { margin-top: 14px; font-size: 17.5px; }
.meta { color: var(--ink-3); font-size: 14.5px; }
.foot { margin: 32px 0 0; color: var(--ink-3); font-size: 14px; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.flush { margin-top: 0; }

/* Cards; a status card is the "next step" wash */
.card { margin: 16px 0; padding: 20px 22px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--sh-xs); }
main:not(.wide) .card { background: var(--ground); box-shadow: none; }
main:not(.wide) .card[role="status"] { border-color: var(--line-tint); border-radius: var(--r-panel); background: linear-gradient(115deg, var(--tint), var(--surface) 60%, var(--peach) 140%); }
.card[role="status"] > strong:first-child::before, .card[role="status"] > p:first-child > strong:first-child::before { content: ""; display: inline-block; width: 7px; height: 7px; margin: 0 10px 2px 0; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.card > strong:first-child { display: block; }
.card > strong:first-child + p { margin-top: 6px; }

/* A job's facts: one row between hairlines */
.facts { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 20px 0 0; padding: 14px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); list-style: none; }
.fact { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; color: var(--ink-2); font-size: 14.5px; line-height: 1.4; overflow-wrap: anywhere; }
.fact .icon { color: var(--primary); }
.facts.small { gap: 4px 16px; margin-top: 8px; padding: 0; border: 0; }
.facts.small .fact { color: var(--ink-3); font-size: 13.5px; }
.facts.small .icon { width: 14px; height: 14px; color: inherit; }

/* Buttons: a plum pill for the main action, outlined pills for the rest */
.btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 48px; margin: 16px 0 0; padding: 12px 24px; border: 1px solid var(--primary); border-radius: var(--r-pill); background: var(--primary); color: var(--on-primary); font: 600 16px/1.25 var(--ui); text-align: center; text-decoration: none; cursor: pointer; box-shadow: var(--sh-primary); transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease; }
@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); } }
.btn.secondary { background: var(--surface); border-color: var(--line-2); color: var(--ink); }
@media (hover: hover) and (pointer: fine) { .btn.secondary:hover { background: var(--surface-2); border-color: var(--line-strong); } }
.btn.secondary, .btn.go, .btn:disabled { box-shadow: none; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn .icon { width: 18px; height: 18px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.actions > form { display: contents; }
.actions + p { margin-top: 14px; }
.actions .btn, p > .btn { margin: 0; }
@media (min-width: 600px) { .btn { display: inline-flex; width: auto; min-width: 200px; } form:not(.actions) > .btn + .btn { margin-left: 12px; } }
@media (prefers-reduced-motion: no-preference) { .btn:active:not(:disabled) { transform: scale(0.97); } }

/* Apply now (founder decision Q2 = A): on hover or keyboard focus the plum fill slides across (transform only) and
   the words turn light as it passes them */
.btn.go { position: relative; isolation: isolate; overflow: hidden; justify-content: flex-start; gap: 12px; min-height: 52px; padding: 4px 24px 4px 4px; border-color: var(--line-strong); background: var(--tint); color: var(--ink); transition: border-color 150ms ease, color 50ms linear 35ms, transform 150ms ease; }
.go-fill { position: absolute; top: 4px; right: 4px; bottom: 4px; left: 4px; z-index: -1; border-radius: inherit; background: var(--primary); transform: translateX(calc(-100% - 4px)); }
.go-icon { display: grid; place-items: center; flex: none; width: 42px; height: 42px; border-radius: 50%; background: var(--primary); color: var(--on-primary); }
.go-text { flex: 1 1 auto; min-width: 0; text-align: center; overflow-wrap: anywhere; }
.btn.go:focus-visible { outline-offset: 3px; }
.btn.go:focus-visible, .btn.go:active { border-color: var(--primary); color: var(--on-primary); transition: border-color 150ms ease, color 50ms linear 55ms, transform 150ms ease; }
.btn.go:focus-visible .go-fill, .btn.go:active .go-fill { transform: none; }
@media (hover: hover) and (pointer: fine) {
  .btn.go:hover { border-color: var(--primary); color: var(--on-primary); transition: border-color 150ms ease, color 50ms linear 55ms, transform 150ms ease; }
  .btn.go:hover .go-fill { transform: none; }
  .btn.go:hover .go-icon .icon { transform: translateX(2px); }
}
@media (prefers-reduced-motion: no-preference) { .go-fill, .go-icon .icon { transition: transform 200ms ease-out; } }

/* Forms: field edges that can be seen (WCAG 1.4.11) */
label { display: block; margin: 20px 0 8px; color: var(--ink); font-size: 14.5px; font-weight: 600; }
input[type=text], input[type=email], input[type=tel], input[type=date], input[type=number], textarea, select { display: block; width: 100%; min-height: 48px; padding: 11px 14px; border: 1px solid var(--line-strong); border-radius: var(--r-control); background: var(--surface); color: var(--ink); font: inherit; transition: border-color 150ms ease; }
@media (hover: hover) and (pointer: fine) { :is(input, textarea, select):hover, .slot:hover { border-color: var(--ink-3); } }
:is(input, textarea, select):focus { border-color: var(--primary); }
select, option, optgroup { background-color: var(--surface); color: var(--ink); }
textarea { min-height: 120px; resize: vertical; }
::placeholder { color: var(--ink-3); opacity: 1; }
[aria-invalid="true"] { border-color: var(--critical); box-shadow: 0 0 0 1px var(--critical); }
input[type=file] { display: block; width: 100%; padding: 14px; border: 1.5px dashed var(--line-strong); border-radius: var(--r-card); background: var(--tint); color: var(--ink-2); font: inherit; font-size: 14.5px; }
input[type=file]::file-selector-button { margin-right: 14px; padding: 9px 18px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink); font: 600 14.5px/1.2 var(--ui); cursor: pointer; }
@media (hover: hover) and (pointer: fine) { input[type=file]::file-selector-button:hover { background: var(--surface-2); } }
input[type=checkbox], input[type=radio] { accent-color: var(--primary); }
.check { display: flex; align-items: flex-start; gap: 12px; margin: 12px 0; color: var(--ink); font-weight: 400; }
.check input { flex: none; width: 20px; height: 20px; margin: 2px 0 0; }
.slot { align-items: center; margin: 8px 0 0; padding: 12px 16px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--surface); font-weight: 600; cursor: pointer; }
.slot:has(input:checked) { border-color: var(--primary); background: var(--tint); box-shadow: inset 0 0 0 1px var(--primary); }
.slot input { margin: 0; }
.code { max-width: 240px; font-family: var(--mono); font-size: 22px; letter-spacing: 0.3em; font-variant-numeric: tabular-nums; }
form small, .form-preview small { display: block; margin-top: 6px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { padding: 0; color: var(--ink-3); font-size: 14.5px; }
legend.question-legend { margin: 0 0 6px; color: var(--ink); font-size: 15px; font-weight: 600; }
/* A QR code scans on light only */
.qr { padding: 8px; border-radius: var(--r-control); background: white; }

/* Notices are the law, not small print */
.notice { margin: 16px 0; padding: 14px 16px; border: 1px solid var(--line-tint); border-radius: var(--r-card); background: var(--tint); color: var(--ink-2); font-size: 14.5px; }
div.notice > p:first-child { color: var(--ink); font-weight: 600; }
.err, .alert { margin: 16px 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-card); font-size: 15px; }
.err, .alert.critical { background: var(--critical-soft); border-color: var(--critical-soft); color: var(--critical); }
.alert.caution { background: var(--caution-soft); border-color: var(--caution-soft); color: var(--caution); }
.err strong, .alert strong, .err a, .alert a { color: inherit; }

/* Steps, lists, label/value rows */
ol.steps { display: grid; gap: 14px; margin: 16px 0 8px; padding: 0; list-style: none; counter-reset: step; }
ol.steps > li { position: relative; min-height: 30px; padding: 3px 0 0 44px; color: var(--ink-2); counter-increment: step; }
ol.steps > li::before { content: counter(step); content: counter(step) / ""; position: absolute; top: 0; left: 0; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--tint-2); color: var(--primary); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
ul.steps { margin: 12px 0 16px; padding-left: 22px; color: var(--ink-2); }
ul.steps li { margin: 6px 0; }
ul.steps li::marker { color: var(--accent); }
.status { display: grid; padding-top: 4px; padding-bottom: 4px; }
.status > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.status > div:last-child { border-bottom: 0; }
.status > div > :first-child { color: var(--ink-3); }
.status > div > :last-child { min-width: 0; text-align: right; overflow-wrap: anywhere; }
.status > div > span:last-child { color: var(--ink); }

/* The company: its logo, or its initials on a plum tile */
.company { display: flex; align-items: center; gap: 14px; margin: 0 0 22px; }
.company > div { min-width: 0; overflow-wrap: anywhere; }
.company .eyebrow { margin: 0; }
.logo { flex: none; display: grid; place-items: center; width: 56px; height: 56px; overflow: hidden; border-radius: 14px; background: var(--primary); color: var(--on-primary); font: 700 20px/1 var(--display); }
.logo img { display: block; width: 100%; height: 100%; object-fit: contain; border: 1px solid var(--line); border-radius: inherit; background: var(--surface); }

/* Careers: a hero, then the jobs as rows of one list */
.careers { max-width: 920px; margin: 0 auto; }
.careers-head { margin: 0 0 40px; }
.careers-head h1, .job-head h1 { margin-top: 28px; font-size: 52px; line-height: 1.02; letter-spacing: -0.04em; }
.careers-head h1 span { color: var(--primary); }
.careers-head .lead { max-width: 60ch; font-size: 18px; }
.roles { display: grid; gap: 12px; margin: 16px 0 24px; padding: 0; list-style: none; }
.careers .roles { gap: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--sh-xs); }
.careers .role { padding: 22px 24px; border: 0; border-radius: 0; box-shadow: none; }
.careers .role + .role { border-top: 1px solid var(--line); }
.role { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 20px; margin: 0; }
.role-icon { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 12px; background: var(--tint-2); color: var(--primary); }
.role-icon .icon { width: 20px; height: 20px; }
.role-main { flex: 1 1 200px; min-width: 0; }
.role h3 { margin: 0; font-size: 19px; }
.role .meta { margin: 8px 0 0; font-size: 13.5px; }
.role .btn { margin: 0; }
.excerpt { margin: 8px 0 0; color: var(--ink-2); font-size: 15px; }

/* The job page: the apply card beside it; on a phone a bar at the bottom */
.job-head { margin: 0 0 36px; }
.head-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 24px; }
.head-actions .btn { margin: 0; }
.apply-by { display: inline-flex; align-items: center; gap: 8px; margin: 0; color: var(--ink); font-size: 15px; font-weight: 600; }
.apply-by .icon { color: var(--ink-3); }
.job-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 48px; align-items: start; }
.job-layout.solo { grid-template-columns: minmax(0, 760px); }
.job-main { min-width: 0; }
.job-body { margin: 0; padding: 0; background: none; border: 0; box-shadow: none; }
.desc { color: var(--ink-2); font-size: 16px; line-height: 1.7; overflow-wrap: anywhere; }
.desc p { margin: 0 0 14px; color: inherit; white-space: pre-line; }
.desc ul, .desc ol { margin: 6px 0 16px; padding-left: 22px; }
.desc li { margin: 6px 0; }
ul.checks { display: grid; gap: 10px; margin: 12px 0 8px; padding: 0; list-style: none; }
ul.checks li { display: flex; align-items: flex-start; gap: 10px; color: var(--ink-2); }
ul.checks .icon { margin-top: 4px; color: var(--primary); }
.about { margin: 32px 0 0; padding: 28px 32px; background: var(--surface-2); box-shadow: none; }
.about .pre { color: var(--ink); }
.site { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; font-weight: 600; }
.apply-panel { position: sticky; top: 24px; z-index: 5; }
.apply-card { margin: 0; padding: 24px; border-radius: var(--r-panel); }
.apply-card .btn { display: flex; width: 100%; margin: 0; }
.apply-card .apply-by { margin-bottom: 14px; font-size: 14.5px; }
.points { display: grid; gap: 12px; margin: 20px 0 0; padding: 18px 0 0; border-top: 1px solid var(--line); list-style: none; }
.points li { display: flex; align-items: flex-start; gap: 12px; color: var(--ink-2); font-size: 14.5px; line-height: 1.45; }
.points .icon { width: 28px; height: 28px; padding: 6px; border-radius: 8px; background: var(--tint-2); color: var(--primary); }
.points li > span { min-width: 0; padding-top: 4px; overflow-wrap: anywhere; }
.help-line { margin: 16px 0 0; color: var(--ink-3); font-size: 13.5px; overflow-wrap: anywhere; }
.points-card { display: none; }
@media (max-width: 899px) {
  html:has(.apply-panel) { scroll-padding-bottom: 104px; }
  .job-layout, .job-layout.solo { display: block; }
  .job-body { margin-bottom: 24px; }
  .head-apply { display: none; }
  .points-card { display: block; margin: 0 0 28px; }
  .points-card .points { margin: 0; padding: 0; border: 0; }
  .apply-panel { top: auto; bottom: 12px; }
  .apply-panel .apply-card { padding: 6px; border-color: var(--line-2); border-radius: var(--r-pill); box-shadow: var(--sh-pop); }
  .apply-card > p, .apply-card > .points { display: none; }
}

/* The signed-in preview's note (plan D1) */
.preview-note { margin: 0 0 28px; padding: 14px 18px; border-radius: var(--r-card); background: var(--caution-soft); color: var(--caution); font-size: 14.5px; }
.preview-note strong, .preview-note a, .preview-note p { color: inherit; }
.preview-note ul { margin: 8px 0 0; padding-left: 20px; }

/* Disclosures that work without script; each summary a 40px tap target */
details.no-resume { margin: 20px 0 0; padding: 5px 16px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--surface); }
details.no-resume[open] { padding-bottom: 16px; }
details.no-resume > summary, details.more > summary { padding: 9px 0; color: var(--ink); font-weight: 600; cursor: pointer; }
details.no-resume fieldset > p { margin: 10px 0 0; }
details.no-resume label { margin-top: 16px; }
details.more { margin-top: 4px; }
details.more > summary { color: var(--ink-2); }
@media (max-width: 600px) {
  main { width: auto; margin: 12px; padding: 26px 18px 28px; border-radius: var(--r-card); }
  main.wide { margin: 0 auto; padding: 28px 16px 48px; }
  h1 { font-size: 28px; }
  .careers-head h1, .job-head h1 { font-size: 36px; }
  .card, .careers .role { padding: 18px; }
  .job-body { padding: 0; }
  .about { padding: 22px 18px; }
  .logo { width: 48px; height: 48px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
`;

/** JSON for a script element: "<", ">" and the line separators are escaped so owner-written text can never close the element. */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * What a link to a public page shows when it is pasted into a chat or a post (plan D8/D10): the job and the employer,
 * the first words of the description, and the logo when there is one. Plain meta tags read by the app the link is pasted
 * into; nothing is loaded from those apps.
 */
export type ShareTags = { title: string; description: string; url: string; siteName: string; image?: string | null };

/**
 * `wide` lays the page on the open ground at full width (the job page) instead of the narrow white sheet; `extraCss` is a
 * page's own styles (the screening conversation), in the head with the same nonce. `description` and `share` are for
 * search engines and link previews on public pages; `noindex` keeps a page out of search results (the authenticated
 * preview of a job that is not public yet).
 */
export const Layout: FC<{ title: string; children?: unknown; jsonLd?: Record<string, unknown>; nonce?: string; wide?: boolean; extraCss?: string; description?: string; share?: ShareTags; noindex?: boolean }> = (props) => {
  const nonce = props.nonce ?? currentNonce();
  const share = props.share;
  return (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      {props.noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
      <title>{props.title}</title>
      {props.description ? <meta name="description" content={props.description} /> : null}
      {share ? <link rel="canonical" href={share.url} /> : null}
      {share ? <meta property="og:type" content="website" /> : null}
      {share ? <meta property="og:title" content={share.title} /> : null}
      {share ? <meta property="og:description" content={share.description} /> : null}
      {share ? <meta property="og:url" content={share.url} /> : null}
      {share ? <meta property="og:site_name" content={share.siteName} /> : null}
      {share?.image ? <meta property="og:image" content={share.image} /> : null}
      {share ? <meta name="twitter:card" content="summary" /> : null}
      <style nonce={nonce} dangerouslySetInnerHTML={{ __html: CSS }} />
      {props.extraCss ? <style nonce={nonce} dangerouslySetInnerHTML={{ __html: props.extraCss }} /> : null}
      {props.jsonLd ? <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: safeJsonLd(props.jsonLd) }} /> : null}
    </head>
    <body>
      <main class={props.wide ? "wide" : undefined}>{props.children}</main>
    </body>
  </html>
);
};
