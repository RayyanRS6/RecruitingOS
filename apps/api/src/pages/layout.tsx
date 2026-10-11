/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { getContext } from "hono/context-storage";
import type { Vars } from "../middleware/session";
import { fontFaceCss } from "./fonts";

/** The nonce the policy middleware issued for this request; empty outside a request (unit renders). */
export function currentNonce(): string {
  try { return getContext<Vars>().get("nonce") ?? ""; } catch { return ""; }
}

/**
 * Candidate-facing pages are server-rendered, mobile-first, and need no JavaScript. They wear the application's look
 * (docs/07): a warm off-white ground, a white sheet for the page's content, near-black primary buttons, outlined
 * secondary ones, small uppercase eyebrows, and pills for a job's facts. The token values below are copied from
 * packages/ui/src/tokens.css (this page cannot import a stylesheet; candidate-look.test.ts fails if the two drift), and
 * the fonts come from this deployment's own origin (fonts.ts), so the content-security policy needs no outside host.
 */
export const CSS = `
${fontFaceCss()}
:root {
  --ground: #f7f5f0;
  --surface: #ffffff;
  --surface-2: #f1eee7;
  --line: #e5e0d5;
  --line-2: #d9d3c7;
  --line-strong: #8c8578;
  --ink: #1c1a17;
  --ink-2: #4f4b44;
  --ink-3: #68635a;
  --primary: #1c1a17;
  --primary-hover: #3a3631;
  --on-primary: #ffffff;
  --accent: #2f4be0;
  --accent-ink: #2238b8;
  --accent-soft: #e8ecff;
  --caution: #875300;
  --caution-soft: #fbf0d6;
  --caution-line: #f0d89b;
  --critical: #b42318;
  --critical-soft: #fdecea;
  --critical-line: #f6c7c2;
  --shadow-float: 0 1px 2px rgba(28, 26, 23, 0.06), 0 18px 40px -18px rgba(28, 26, 23, 0.32);
  --display: "Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif;
  --ui: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", Menlo, Consolas, monospace;
  --r-control: 8px;
  --r-card: 12px;
  --r-panel: 16px;
  --r-pill: 999px;
  --link: var(--accent-ink);
  --focus: var(--accent);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0e0e10;
    --surface: #18181b;
    --surface-2: #25252a;
    --line: #2c2c31;
    --line-2: #3f3f46;
    --line-strong: #78787f;
    --ink: #ededf0;
    --ink-2: #c6c6cc;
    --ink-3: #a1a1aa;
    --primary: #ededf0;
    --primary-hover: #d1d1d6;
    --on-primary: #0e0e10;
    --accent: #8ea0ff;
    --accent-ink: #aab8ff;
    --accent-soft: #232a52;
    --caution: #f1c45e;
    --caution-soft: #342c1e;
    --caution-line: #604c22;
    --critical: #ff9389;
    --critical-soft: #392424;
    --critical-line: #6b3633;
    --shadow-float: 0 1px 2px rgba(0, 0, 0, 0.4), 0 18px 40px -16px rgba(0, 0, 0, 0.75);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.55 var(--ui); -webkit-font-smoothing: antialiased; }
main { width: min(680px, calc(100% - 32px)); margin: 40px auto 64px; padding: 36px 40px 40px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-panel); }
main.wide { width: auto; max-width: 1080px; margin: 0 auto; padding: 40px 24px 72px; background: none; border: 0; border-radius: 0; }
h1, h2, h3 { color: var(--ink); font-family: var(--display); font-weight: 700; text-wrap: balance; overflow-wrap: anywhere; }
h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.12; letter-spacing: -0.02em; }
h2 { margin: 32px 0 10px; font-size: 19px; line-height: 1.3; letter-spacing: -0.01em; }
h3 { margin: 22px 0 8px; font-size: 17px; line-height: 1.35; }
.card > h2:first-child, .card > label:first-child { margin-top: 0; }
p { margin: 0 0 12px; color: var(--ink-2); }
p:last-child { margin-bottom: 0; }
strong { color: var(--ink); font-weight: 600; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
small { color: var(--ink-3); font-size: 13.5px; }
code { font-family: var(--mono); font-size: 15px; letter-spacing: 0.04em; }
img { max-width: 100%; height: auto; }
::selection { background: var(--accent-soft); color: var(--ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.icon { flex: none; width: 16px; height: 16px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

/* Page heads: an eyebrow (written in normal case, raised by CSS), a back link, a lead paragraph */
.eyebrow { margin: 0 0 12px; color: var(--ink-3); font: 600 12px/1.45 var(--ui); letter-spacing: 0.14em; text-transform: uppercase; }
.eyebrow a { color: inherit; }
.back { margin: 0 0 20px; font-size: 14.5px; }
.back a { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-weight: 600; text-decoration: none; }
.back a:hover { color: var(--ink); text-decoration: underline; }
.lead { margin-top: 14px; font-size: 17px; }
.meta { color: var(--ink-3); font-size: 14.5px; }
.foot { margin: 28px 0 0; color: var(--ink-3); font-size: 14px; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.flush { margin-top: 0; }

/* Surfaces: inside the white sheet a card is a sunken box; on the open ground (the job page) it is the white surface */
.card { margin: 16px 0; padding: 18px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); }
main:not(.wide) .card { background: var(--ground); }
.card > strong:first-child { display: block; }
.card > strong:first-child + p { margin-top: 6px; }

/* A job's facts as pills, each with its icon; the words say what each one is */
.facts { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; padding: 0; list-style: none; }
.fact { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-height: 32px; padding: 5px 12px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink); font-size: 14px; font-weight: 600; line-height: 1.3; }
.fact .icon { color: var(--ink-3); }

/* Buttons: near-black for the one main action, outlined for everything else; full width on a phone */
.btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin: 16px 0 0; padding: 13px 22px; border: 1px solid var(--primary); border-radius: var(--r-control); background: var(--primary); color: var(--on-primary); font: 600 16px/1.25 var(--ui); text-align: center; text-decoration: none; cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease; }
@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); } }
.btn.secondary { background: var(--surface); border-color: var(--line-2); color: var(--ink); }
@media (hover: hover) and (pointer: fine) { .btn.secondary:hover { background: var(--surface-2); border-color: var(--ink-3); } }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.actions > form { display: contents; }
.actions + p { margin-top: 14px; }
.actions .btn, p > .btn { margin: 0; }
@media (min-width: 600px) { .btn { display: inline-flex; width: auto; min-width: 200px; } }
@media (prefers-reduced-motion: no-preference) { .btn:active:not(:disabled) { transform: scale(0.97); } }

/* Apply now (founder decision Q2 = A, 10 October 2026): on hover or keyboard focus the dark fill slides across the words
   (transform only). The edge is the field-border grey, so the pill shows on the open ground as on a card. The words turn
   as the fill passes their middle: from 55ms on the way in, from 35ms on the way out. */
.btn.go { position: relative; isolation: isolate; overflow: hidden; justify-content: flex-start; gap: 12px; min-height: 48px; padding: 4px 22px 4px 4px; border-color: var(--line-strong); border-radius: var(--r-pill); background: var(--surface-2); color: var(--ink); transition: border-color 150ms ease, color 50ms linear 35ms, transform 150ms ease; }
.go-fill { position: absolute; top: 4px; right: 4px; bottom: 4px; left: 4px; z-index: -1; border-radius: inherit; background: var(--primary); transform: translateX(calc(-100% - 4px)); }
.go-icon { display: grid; place-items: center; flex: none; width: 38px; height: 38px; border-radius: 50%; background: var(--primary); color: var(--on-primary); }
.go-icon .icon { width: 18px; height: 18px; }
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

/* Forms: fields with borders that can be seen (WCAG 1.4.11), a clear mark on a field that needs attention */
label { display: block; margin: 20px 0 6px; color: var(--ink); font-size: 15px; font-weight: 600; }
input[type=text], input[type=email], input[type=tel], input[type=date], input[type=number], textarea, select { display: block; width: 100%; min-height: 48px; padding: 11px 14px; border: 1px solid var(--line-strong); border-radius: var(--r-control); background: var(--surface); color: var(--ink); font: inherit; transition: border-color 150ms ease; }
input[type=text]:hover, input[type=email]:hover, input[type=tel]:hover, input[type=date]:hover, input[type=number]:hover, textarea:hover, select:hover { border-color: var(--ink-3); }
textarea { min-height: 112px; resize: vertical; }
::placeholder { color: var(--ink-3); opacity: 1; }
[aria-invalid="true"] { border-color: var(--critical); box-shadow: 0 0 0 1px var(--critical); }
input[type=file] { display: block; width: 100%; color: var(--ink-2); font: inherit; font-size: 15px; }
input[type=file]::file-selector-button { margin-right: 12px; padding: 10px 16px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--surface); color: var(--ink); font: 600 15px/1.2 var(--ui); cursor: pointer; }
@media (hover: hover) and (pointer: fine) { input[type=file]::file-selector-button:hover { background: var(--surface-2); } }
input[type=checkbox], input[type=radio] { accent-color: var(--ink); }
.check { display: flex; align-items: flex-start; gap: 10px; margin: 12px 0; color: var(--ink); font-weight: 400; }
.check input { flex: none; width: 20px; height: 20px; margin: 2px 0 0; }
.slot { align-items: center; margin: 8px 0 0; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--surface); font-weight: 600; cursor: pointer; }
.slot:hover { border-color: var(--ink-3); }
.slot:has(input:checked) { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.slot input { margin: 0; }
.code { max-width: 240px; font-family: var(--mono); font-size: 22px; letter-spacing: 0.3em; font-variant-numeric: tabular-nums; }
form small, .form-preview small { display: block; margin-top: 6px; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
legend { padding: 0; color: var(--ink-3); font-size: 14.5px; }
legend.question-legend { margin: 0 0 6px; color: var(--ink); font-size: 15px; font-weight: 600; }
/* A QR code needs a light background in both themes to scan. */
.qr { padding: 8px; border-radius: var(--r-control); background: white; }

/* Notices stay readable (the AI and pay notices are the law, not small print); alerts carry a tone and a word */
.notice { margin: 16px 0; padding: 12px 14px; border-radius: var(--r-control); background: var(--surface-2); color: var(--ink-2); font-size: 14.5px; line-height: 1.5; }
.err, .alert { margin: 16px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-control); font-size: 15px; }
.err, .alert.critical { background: var(--critical-soft); border-color: var(--critical-line); color: var(--critical); }
.alert.caution { background: var(--caution-soft); border-color: var(--caution-line); color: var(--caution); }
.err strong, .alert strong, .err a, .alert a { color: inherit; }

/* Numbered steps, plain lists, and label/value rows */
ol.steps { display: grid; gap: 14px; margin: 14px 0 8px; padding: 0; list-style: none; counter-reset: step; }
ol.steps > li { position: relative; min-height: 28px; padding: 2px 0 0 42px; color: var(--ink-2); counter-increment: step; }
ol.steps > li::before { content: counter(step); content: counter(step) / ""; position: absolute; top: 0; left: 0; display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--line-2); border-radius: 50%; background: var(--surface); color: var(--ink); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
ul.steps { margin: 10px 0 16px; padding-left: 22px; color: var(--ink-2); }
ul.steps li { margin: 6px 0; }
.status { display: grid; padding-top: 4px; padding-bottom: 4px; }
.status > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.status > div:last-child { border-bottom: 0; }
.status > div > :first-child { color: var(--ink-3); }
.status > div > :last-child { min-width: 0; text-align: right; overflow-wrap: anywhere; }
.status > div > span:last-child { color: var(--ink); }

/* The company on its own pages: the logo (or its initials) beside its name */
.company { display: flex; align-items: center; gap: 14px; margin: 0 0 18px; }
.company > div { min-width: 0; overflow-wrap: anywhere; }
.company .eyebrow { margin: 0; }
.logo { flex: none; display: grid; place-items: center; width: 56px; height: 56px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); color: var(--ink); font: 700 20px/1 var(--display); }
.logo img { display: block; width: 100%; height: 100%; object-fit: contain; }

/* The careers page: who the company is, then each open job as a card with its facts and its first lines */
.careers { max-width: 860px; margin: 0 auto; }
.careers-head { margin: 0 0 8px; }
.roles { display: grid; gap: 12px; margin: 16px 0 24px; padding: 0; list-style: none; }
.role { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 24px; margin: 0; }
.role-main { flex: 1 1 420px; min-width: 0; }
.role h3 { margin: 0; font-size: 19px; }
.role .facts { margin-top: 10px; }
.role .meta { margin: 8px 0 0; }
.role .btn { margin: 0; }
.excerpt { margin: 10px 0 0; color: var(--ink-2); font-size: 15px; }
.facts.small .fact { min-height: 28px; padding: 3px 10px; font-size: 13.5px; }

/* The job page: the heading on the open ground with a second Apply button, the description in headed sections on a
   white card, and the apply panel beside it; on a phone the panel becomes a bar held at the bottom of the screen */
.job-head { margin: 0 0 28px; }
.job-head h1 { font-size: 40px; line-height: 1.08; }
.head-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-top: 20px; }
.head-actions .btn { margin: 0; }
.apply-by { display: inline-flex; align-items: center; gap: 7px; margin: 0; color: var(--ink); font-size: 15px; font-weight: 600; }
.apply-by .icon { color: var(--ink-3); }
.job-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start; }
.job-layout.solo { grid-template-columns: minmax(0, 760px); }
.job-main { min-width: 0; }
.job-body { margin: 0; padding: 32px 36px; }
.job-body > h2:first-child { margin-top: 0; }
.desc { color: var(--ink); font-size: 16.5px; line-height: 1.65; overflow-wrap: anywhere; }
.desc p { margin: 0 0 14px; color: var(--ink); white-space: pre-line; }
.desc ul, .desc ol { margin: 6px 0 16px; padding-left: 22px; }
.desc li { margin: 6px 0; }
ul.checks { display: grid; gap: 10px; margin: 12px 0 8px; padding: 0; list-style: none; }
ul.checks li { display: flex; align-items: flex-start; gap: 10px; color: var(--ink); }
ul.checks .icon { margin-top: 4px; color: var(--ink-2); }
.about { margin: 16px 0 0; padding: 28px 36px; }
.about > h2:first-child { margin-top: 0; }
.about .pre { color: var(--ink); }
.site { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; font-weight: 600; }
.apply-panel { position: sticky; top: 24px; z-index: 5; }
.apply-card { margin: 0; padding: 20px; }
.apply-card .btn { display: flex; width: 100%; margin-top: 14px; }
.apply-card .apply-by { margin-top: 6px; font-size: 14.5px; }
.apply-title { margin: 0 0 4px; color: var(--ink); font: 700 18px/1.3 var(--display); }
.points { display: grid; gap: 10px; margin: 16px 0 0; padding: 14px 0 0; border-top: 1px solid var(--line); list-style: none; }
.points li { display: flex; align-items: flex-start; gap: 10px; color: var(--ink-2); font-size: 14.5px; line-height: 1.45; }
.points .icon { margin-top: 2px; color: var(--ink-3); }
.points li > span { min-width: 0; overflow-wrap: anywhere; }
.help-line { margin: 14px 0 0; color: var(--ink-3); font-size: 14px; overflow-wrap: anywhere; }
.points-card { display: none; }
@media (max-width: 899px) {
  html:has(.apply-panel) { scroll-padding-bottom: 104px; }
  .job-layout, .job-layout.solo { display: block; }
  .job-body { margin-bottom: 16px; }
  .head-apply { display: none; }
  .points-card { display: block; margin: 0 0 16px; }
  .points-card .points { margin: 0; padding: 0; border: 0; }
  .apply-panel { top: auto; bottom: 12px; }
  .apply-card { padding: 10px; border-color: var(--line-2); box-shadow: var(--shadow-float); }
  .apply-card > p, .apply-card > .points { display: none; }
  .apply-card .btn { margin: 0; }
}

/* The authenticated preview (plan D1): a plain note that the page is not public, and a form that sends nothing */
.preview-note { margin: 0 0 24px; padding: 14px 16px; border: 1px solid var(--caution-line); border-radius: var(--r-card); background: var(--caution-soft); color: var(--caution); }
.preview-note strong, .preview-note a { color: inherit; }
.preview-note ul { margin: 8px 0 0; padding-left: 20px; }
.preview-note p { color: inherit; }

/* Applying without a resume: four short questions behind a disclosure that works without script */
details.no-resume { margin: 20px 0 0; padding: 14px 16px; border: 1px solid var(--line-2); border-radius: var(--r-card); background: var(--surface); }
details.no-resume > summary { color: var(--ink); font-weight: 600; cursor: pointer; }
details.no-resume fieldset > p { margin: 10px 0 0; }
details.no-resume label { margin-top: 16px; }
@media (max-width: 600px) {
  main { width: auto; margin: 12px; padding: 24px 18px 28px; border-radius: var(--r-card); }
  main.wide { margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 27px; }
  .job-head h1 { font-size: 30px; }
  .card { padding: 16px; }
  .job-body, .about { padding: 22px 18px; }
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
