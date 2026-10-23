# Working on Recruiting OS

Recruiting OS is a hiring app for small businesses: the owner says who they need, the software runs the process (job post, applications, AI review with evidence, screening chat, scheduling), a person makes every hiring decision, and a real recruiter is one click away. This guide is for AI agents and developers who change the code. Start with [README.md](README.md) (how to run it) and [docs/README.md](docs/README.md) (the product documents). Product decisions, with who made them and when, are in [docs/workflow-decisions.md](docs/workflow-decisions.md): read it before asking a question that may already be settled.

## Workspace map

| Path | What it is |
|---|---|
| `apps/shell` | The Next.js 15 + React 19 app (Vercel). Routes in `app/`, the frame (sidebar, top bar) in `components/AppShell.tsx`, the one stylesheet entry `app/globals.css`, the CSS build in `scripts/build-css.mjs`. The API is mounted inside it. |
| `apps/web` | The signed-in pages for owners, recruiters and admins (`src/pages`, `src/components`) and their pure helpers (`src/*.ts`). |
| `apps/api` | The Hono API, webhooks, the worker, and the candidate pages (`src/pages`, rendered on the server). |
| `packages/ui` | The design system: components (`src/index.tsx`, plus client components in their own files), icons (`src/glyphs.ts`), and the whole look (`src/styles.css`). |
| `packages/core` | Policy engine, state machine, auth, permissions, and the compliance layer (notices candidates must see). |
| `packages/contracts`, `db`, `workflows`, `ai`, `agents`, `integrations`, `playbooks`, `evals` | Schemas; Drizzle schema, migrations and RLS; the durable workflow engine; the AI provider layer and prompts; the agents; email, SMS and job boards; vertical playbooks; evaluation suites. |
| `tests/` | `scenario` (the end-to-end hiring scenario on PGlite), `web` (tests of the signed-in pages in `apps/web`), `policy` (repository-wide guards), `e2e` (Playwright). |
| `docs/` | `07-ux-and-design-system.md` is the design system; `STATUS.md` is where the build stands. |

## Checks

- `pnpm test`: every Vitest suite on PGlite with stand-in providers (no network, no real AI). One file: `pnpm test path/to/file.test.ts`.
- `pnpm typecheck`: `tsc` in every package.
- `pnpm lint`: Biome.
- `pnpm css`: builds the stylesheet (Tailwind CSS v4 through PostCSS) and prints its size. It fails on broken CSS or an unknown class in `@apply`. `pnpm css out.css` also writes the file.
- `pnpm e2e`: the Playwright specs.

Run the tests for what you touched, the typecheck of each package you changed, and `pnpm css` after any change to `styles.css` or to class names.

## UI rules

- **Where the look lives.** `packages/ui/src/styles.css` holds the tokens (custom properties on `:root`, and two identical dark blocks) and `@layer components`, which styles every kit class. Tailwind's own palette is switched off, so only our token colours exist as classes (`bg-surface`, `text-ink-2`, `border-line`, `bg-primary`…), and they flip with the theme by themselves.
- **Kit first.** Use the `@ros/ui` components and kit classes (`card`, `list-row`, `pill`, `eyebrow`, `option-row`, `dl.glance`… listed in docs/07), then Tailwind utilities for layout. Pass `className` to place a kit component. A page's one next step is `<Card needsYou hero>` (the kit sizes its title); other cards keep the 19px title. Do not copy a kit class string into a screen or invent a local "look" constant.
- **No inline styles** except a value that is data, passed as a CSS variable and used from a class: ``style={{ "--w": `${pct}%` } as CSSProperties}``.
- **Breakpoints:** Tailwind's named ones only (`sm: md: lg: xl: 2xl:`, `max-sm:`…). Never mix an arbitrary `min-[900px]:` with a named one on the same property.
- **Motion:** enter animations are CSS (`animate-enter`, `animate-fade`). Use `motion/react` only for exits, layout moves and the shared `layoutId` highlight: `m.*` elements inside the `MotionProvider` (never `motion.*`), with `initial={false}` so nothing the server drew is hidden, and never `AnimatePresence mode="popLayout"` (it writes a `<style>` tag, which the content-security policy blocks). Move only `transform` and `opacity`; colours, borders and shadows may transition (hover, focus); everything 320ms or less, never width, height or position. Hover fills wait for a mouse (`hover:` already does), presses wait for `prefers-reduced-motion: no-preference`, and reduced motion stops everything. No blur, no `backdrop-filter`, no WebGL or canvas.
- **Pinned names.** Tests and e2e specs pin many of the kit's class strings and its markup byte for byte (`btn primary sm`, `card`, `pill good sm`, `table-wrap`, `tab`, `chip neutral`…). Do not rename them, and do not add utilities to an element whose exact class string a test pins (wrap it instead). A class kept only as a hook for a test, an e2e spec or a script gets a short comment saying so.
- **Never use a Tailwind utility word as a hook class** (`list-item`, `block`, `table`, `sticky`, `hidden`, `container`, `shrink`…). Tailwind would add that utility's CSS. The audit is at the top of `styles.css`.
- **Native controls stay native:** `<select>`, checkboxes, radios, date and file inputs, `<details>`. Never `appearance: none`.
- **Accessibility:** WCAG AA in both themes (`tokens.test.ts` checks the colours), a visible focus ring, touch targets of 40px or more on phones, no sideways scrolling at 360px wide, and never colour alone (a word goes with every dot).
- **No new dependencies.** The only styling and animation libraries are `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `motion`, `clsx` and `tailwind-merge` (`weight-guard.test.ts`). Icons are our own line drawings in `packages/ui/src/glyphs.ts`. Never copy code from coss.com/ui, shadcn or similar kits (mixed licences).

## Words on screen

The founder's rule (23 October 2026): "Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout." The full lists are in docs/07, "Words on screen".

- **Keep:** page titles and section headings, field labels, button and link text, status words, figures, dates and names, errors and confirmations, things the person must act on, and what customers wrote.
- **Never cut a required notice:** the AI-use disclosure, consent text, privacy and data notices, the accommodation line, pay transparency, "people make every hiring decision", unsubscribe and STOP text, anything `packages/core`'s compliance layer writes, and anything a test names as a legal or founder requirement. If you are unsure, keep it and say so.
- **Cut:** taglines, decorative eyebrows above titles, lines that only describe the page, helper text that repeats a label, keyboard-hint lines, and labels that repeat what is already on screen.
- **Fix the layout instead:** use an icon with an accessible name (`IconLabel`), clear groups with one main action each, an example placeholder inside a field (never instead of its label), or one folded disclosure. Use `title` only as a second aid.
- **Navigation words stay** Home, Jobs, Candidates, Interviews, Settings and Start a hire.

## Tests

- Assertions on behaviour, wording, aria and keyboard handling stay as they are. When a change alters the look, update the assertion that pinned the old look (an old class or an inline style) in the same change, so it pins the new markup with the same intent.
- When words are cut on purpose, update the assertion so it checks the cut. Never cut a required notice to make a test pass.
- Never `.skip` a test, never delete a test's behavioural cases, and never weaken an accessibility assertion.
- The kit's own tests are `packages/ui/src/*.test.ts`. `kit.test.ts` covers markup, `tabs.test.ts` covers keyboard handling, `weight-guard.test.ts` covers CSS rules, motion, libraries and the byte budget, and `tokens.test.ts` covers contrast.

## Candidate pages

The candidate pages (job page, apply form, screening chat, status, scheduling, privacy) live in `apps/api/src/pages`. The server renders them as HTML, and most of them run no script. Their CSS is plain strings (`CSS` in `layout.tsx`, plus `SCREEN_CSS` and `STATUS_CSS`) that carry a copy of the token values. `apps/api/src/candidate-look.test.ts` fails if that copy drifts from `styles.css`, so a colour change goes in both places. Their legal notices are never cut.
