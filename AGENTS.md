# Working on Recruiting OS

Recruiting OS is a hiring app for small businesses. A company signs up and the platform administrator accepts it. The company types a job idea, answers a few follow-up cards, and the AI writes the job with a LinkedIn post and an Indeed post. The company publishes the job itself. Candidates apply on our job page with a short form and a resume. The AI reads each resume once and scores it against the job, the company shortlists, and only shortlisted people get an AI interview by email. A person hires or marks Not selected: the software decides nothing about anyone. This guide is for AI agents and developers who change the code. Start with [README.md](README.md) (how to run it) and [docs/README.md](docs/README.md) (the documents). What the product is, and the decisions still in force, are in [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/DECISIONS.md](docs/DECISIONS.md): read them before asking a question that may already be settled.

## Workspace map

| Path | What it is |
|---|---|
| `apps/shell` | The Next.js 15 + React 19 app (Vercel). Routes in `app/`, the frame (side rail, top bar) in `components/AppShell.tsx`, the one stylesheet entry `app/globals.css`, the CSS build in `scripts/build-css.mjs`. The API is mounted inside it. |
| `apps/web` | The signed-in pages for a company's team and for the platform administrator (`src/pages`, `src/components`) and their pure helpers (`src/*.ts`). |
| `apps/api` | The Hono API, the email webhooks, the worker, and the candidate pages (`src/pages`, rendered on the server). |
| `packages/contracts` | The shapes the API and the pages share, and the one copy of each rule and label: stages, scores, what a person may do with a candidate, plans, the app's addresses. |
| `packages/ui` | The design system: components (`src/index.tsx`, plus client components in their own files), icons (`src/glyphs.ts`), and the whole look (`src/styles.css`). |
| `packages/core` | The moves between stages, the scores read from stored readings, permissions, sign-in and sessions, plans and AI credit, and the compliance layer (the notices candidates must see). |
| `packages/db`, `workflows`, `ai`, `agents`, `integrations`, `evals` | Drizzle schema, migrations and row-level security; the durable workflow engine and its workflows (an application, an AI interview); the AI provider layer and prompts; the agents (job builder, resume reading, AI interview, emails); email, file storage, malware scanning, sign-in, analytics and error reporting; the evaluation suites. |
| `tests/` | `scenario` (one whole hire on PGlite), `web` (tests of the signed-in pages in `apps/web`), `policy` (repository-wide guards), `e2e` (Playwright). |
| `docs/` | `07-ux-and-design-system.md` is the design system; `README.md` lists the rest. |

## One place for each rule

- **Scores.** The two scores (resume score, interview score), their bands and their finding words are worked out in `packages/contracts/src/domain/score.ts`, and read from a stored reading through `packages/core/src/match-score.ts`. The AI writes findings and quotes only. No number and no word about a candidate comes from the AI or from a second implementation, and the server orders every list.
- **Stages.** The nine stages, their tabs and their labels are in `packages/contracts/src/domain/stages.ts`. The moves between them, and `transition`, the only code that writes `applications.stage`, are in `packages/core/src/stages.ts`.
- **What a person may do.** `candidateActions` and `roleActions` in `packages/contracts` decide which buttons a row gets and why one is greyed. The API sends the result and runs the same function before it acts. A screen never decides this.
- **Labels.** The server fills every status word from its one constant in `packages/contracts`. A screen shows the label it gets.

## Checks

- `pnpm test`: every Vitest suite on PGlite with stand-in providers (no network, no real AI). One file: `pnpm test path/to/file.test.ts`.
- `pnpm typecheck`: `tsc` in every package.
- `pnpm lint`: Biome.
- `pnpm css`: builds the stylesheet (Tailwind CSS v4 through PostCSS) and prints its size. It fails on broken CSS or an unknown class in `@apply`. `pnpm css out.css` also writes the file.
- `pnpm db:validate`: checks the migration files.
- `pnpm eval`: the AI evaluation suites on the stand-in AI ([docs/11-evaluation-framework.md](docs/11-evaluation-framework.md)).
- `pnpm e2e`: the Playwright specs.

Run the tests for what you touched, the typecheck of each package you changed, and `pnpm css` after any change to `styles.css` or to class names.

On a Windows machine where an application-control policy blocks pnpm, call the shims in `node_modules\.bin` from the repository root. PowerShell 5.1 has no `&&`: chain with `;`.

- Tests, with the stand-in providers CI sets (the `env` block at the top of `.github/workflows/ci.yml`): `$env:NODE_ENV='test'; $env:CI='1'; $env:AI_PROVIDER='fake'; $env:EMAIL_PROVIDER='fake'; $env:AUTH_PROVIDER='fake'; $env:ANALYTICS_PROVIDER='fake'; $env:STORAGE_PROVIDER='memory'; $env:PGLITE_DIR='memory://'; $env:WORKER_INLINE='true'; $env:MAGIC_LINK_ENABLED='true'; $env:RATE_LIMIT_STORE='fake'; $env:CSP_MODE='report-only'; & node_modules\.bin\vitest.cmd run <files>`
- Typecheck: `& node_modules\.bin\tsc.cmd -p <package>\tsconfig.json` for each package under `apps`, `packages` and `tests`.
- Migration validator: `Set-Location packages\db; & ..\..\node_modules\.bin\tsx.cmd src/cli/validate.ts; Set-Location ..\..`
- Stylesheet: `node apps/shell/scripts/build-css.mjs`
- Biome lint and the Playwright specs cannot run there (Biome's binary is blocked too): they need a CI run.

## UI rules

- **Where the look lives.** `packages/ui/src/styles.css` holds the tokens (custom properties on `:root`, and two identical dark blocks) and `@layer components`, which styles every kit class. Tailwind's own palette is switched off, so only our token colours exist as classes (`bg-surface`, `text-ink-2`, `border-line`, `bg-primary`…), and they flip with the theme by themselves.
- **Kit first.** Use the `@ros/ui` components and kit classes (`card`, `list-row`, `pill`, `eyebrow`, `option-row`, `dl.glance`… listed in docs/07), then Tailwind utilities for layout. Pass `className` to place a kit component. A page's one next step is `<Card needsYou hero>` (the kit sizes its title); other cards keep the 19px title. Do not copy a kit class string into a screen or invent a local "look" constant. Reach for the kit's option first: `PageHeader hero` (Home's greeting size), `Card flush` (a list card, rows edge to edge under its title), `Field aside` (an `IconLabel` beside the label), `Table wrapHeads`, `Pill busy`, `Button keyshortcuts` (announced, no key cap drawn), `IconChip size="xs"` (28px), `Eyebrow as="h2"`/`"h3"`, `className` on `PageHeader` and `Segmented`; classes `ordinal` (the numbered circle), `inline-tag` ("(you)") and `list-row-title wrap`. Cards already have their phone padding.
- **No inline styles** except a value that is data, passed as a CSS variable and used from a class: ``style={{ "--w": `${pct}%` } as CSSProperties}``.
- **Breakpoints:** Tailwind's named ones only (`sm: md: lg: xl: 2xl:`, `max-sm:`…). Use `rail:` / `max-rail:` for the frame's 900px switch (side rail from 900px, top bar under it), never `min-[900px]:`.
- **Motion:** enter animations are CSS (`animate-enter`, `animate-fade`). `motion/react` is for what CSS cannot do, an exit or a layout move; today only the kit's toast uses it. If a page needs it: `m.*` elements inside the `MotionProvider` (never `motion.*`), with `initial={false}` so nothing the server drew is hidden, and never `AnimatePresence mode="popLayout"` (it writes a `<style>` tag, which the content-security policy blocks). Move only `transform` and `opacity`; colours, borders and shadows may transition (hover, focus); everything 320ms or less, never width, height or position. Hover fills wait for a mouse (`hover:` already does), presses wait for `prefers-reduced-motion: no-preference`, and reduced motion stops everything. No blur, no `backdrop-filter`, no WebGL or canvas.
- **Pinned names.** Tests and e2e specs pin many of the kit's class strings and its markup byte for byte (`btn primary sm`, `card`, `pill good sm`, `table-wrap`, `tab`, `chip neutral`…). Do not rename them, and do not add utilities to an element whose exact class string a test pins (wrap it instead). A class kept only as a hook for a test, an e2e spec or a script gets a short comment saying so.
- **Never use a Tailwind utility word as a hook class** (`list-item`, `block`, `table`, `sticky`, `hidden`, `container`, `shrink`…). Tailwind would add that utility's CSS. The audit is at the top of `styles.css`.
- **Native controls stay native:** `<select>`, checkboxes, radios, date and file inputs, `<details>`. Never `appearance: none`.
- **Accessibility:** WCAG AA in both themes (`tokens.test.ts` checks the colours), a visible focus ring, touch targets of 40px or more on phones, no sideways scrolling at 360px wide, and never colour alone (a word goes with every dot).
- **No new dependencies.** The only styling and animation libraries are `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `motion`, `clsx` and `tailwind-merge` (`weight-guard.test.ts`). Icons are our own line drawings in `packages/ui/src/glyphs.ts`. Never copy code from coss.com/ui, shadcn or similar kits (mixed licences).

## Words on screen

The owner's rule (23 October 2026): "Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout." The full lists are in docs/07, "Words on screen".

- **Keep:** page titles and section headings, field labels, button and link text, status words, figures, dates and names, errors and confirmations, things the person must act on, and what customers wrote.
- **Never cut a required notice:** the AI-use disclosure, consent text, privacy and data notices, the accommodation line, pay transparency, "people make every hiring decision", unsubscribe text, anything `packages/core`'s compliance layer writes, and anything a test names as a legal or owner's requirement. If you are unsure, keep it and say so.
- **Cut:** taglines, decorative eyebrows above titles, lines that only describe the page, helper text that repeats a label, keyboard-hint lines, and labels that repeat what is already on screen.
- **Fix the layout instead:** use an icon with an accessible name (`IconLabel`), clear groups with one main action each, an example placeholder inside a field (never instead of its label), or one folded disclosure. Use `title` only as a second aid.
- **Navigation words stay** Home, Jobs, Candidates, Settings and Start a hire. A platform administrator has Companies, Privacy requests and System.
- **The word people read is "resume"**, never "CV" or "résumé", on every screen, page and email. Code names keep `cv*` (`cvScore`, `CvScore`).
- **Code names and screen words differ.** In code a job is a `role` and its record a `packet`; the job builder is `intake`; the AI interview is `screen` (`packet.screening` holds its questions); the application form's "Screening questions" are `packet.formQuestions`; skills are `competencies`; the resume reading is `triage`; Not selected is the stage `rejected`.

## Tests

- Assertions on behaviour, wording, aria and keyboard handling stay as they are. When a change alters the look, update the assertion that pinned the old look (an old class or an inline style) in the same change, so it pins the new markup with the same intent.
- When words are cut on purpose, update the assertion so it checks the cut. Never cut a required notice to make a test pass.
- Never `.skip` a test, never delete a kept feature's behavioural cases, and never weaken an accessibility assertion. A test of a removed feature is deleted with the feature.
- The kit's own tests are `packages/ui/src/*.test.ts`. `kit.test.ts` covers markup, `tabs.test.ts` covers keyboard handling, `weight-guard.test.ts` covers CSS rules, motion, libraries and the byte budget, and `tokens.test.ts` covers contrast.

## Candidate pages

The candidate pages (the careers page, the job page, the application form and its receipt, the status page, the AI interview, "Lost your link?", the privacy notice and the privacy request form) live in `apps/api/src/pages`. The server renders them as HTML, and most of them run no script. A candidate is never shown a score, a band or a finding. No plan or upgrade word ever appears on a candidate page or in a candidate's email: someone past a plan's limit reads the words in `packages/core/src/candidate-lock.ts`, beside the required notices. Their CSS is plain strings: `CSS` in `layout.tsx`, which carries a copy of the token values, and one string beside each page family (`APPLY_CSS`, `STATUS_CSS`, `SCREEN_CSS`, `CHAT_CSS`). `apps/api/src/candidate-look.test.ts` fails if that copy drifts from `styles.css`, so a colour change goes in both places. Their legal notices are never cut. Two more rules there: a block marked DRAFT WORDING PENDING COUNSEL (see `docs/legal-drafts/counsel-register.md`) keeps every word, eyebrows included, until counsel signs off; and a company or job eyebrow stays only where nothing else near the top of the page names the employer or the job (candidate pages have no side rail to say it).
