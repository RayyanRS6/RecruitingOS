# 07. Screens and design system

## The screens

Each screen has one heading and one main action. A screen shows the labels, the order and the buttons the server sends; it sorts nothing and decides nothing ([AGENTS.md](../AGENTS.md), "One place for each rule").

| Screen | Address | What is on it |
|---|---|---|
| Home | `/` | The plan's notices, the "Who are you hiring?" box, drafts, and each open or paused job with how many people are new to review and how many finished the AI interview |
| Jobs | `/roles` | Every job with its status, days open and people by tab; drafts; **Start a hire** |
| The job builder | `/roles/new` | One box; then the conversation with question cards beside what is known and what is still needed; **Write the job**; the written job with its flags, its legal check and one editor; **Publish job** |
| A job | `/roles/<id>` | Three tabs. **Job**: the record section by section, the legal check, one Edit. **Candidates** (`/roles/<id>/talent`). **Share** (`?tab=share`): the Apply link and the two posts, each with Copy, Save and Write again |
| Candidates | `/roles/<id>/talent`, and `/talent` with a job picker | Five tabs with counts: New, Shortlisted, Interviewed, Hired, Not selected. Each row: name, when they applied, the resume score with its band word, the must-have line, flags, where the AI interview stands, the interview score, and its actions. A bar for the ticked people. One card for each locked applicant |
| The candidate panel | `?open=<applicationId>` | The actions for the stage, the decision email shown before it is sent, "Resume match" with the breakdown and the resume itself, "Application" with the form's answers, "AI interview" with its score and each answer |
| Settings | `/setup` | One page: Company, Team, Plan, Email updates |
| Updates | `/updates` | Each person's own updates, read or not |
| Admin dashboard | `/admin`, `/admin/privacy`, `/admin/system` | Companies (requests, the list, one company in a drawer with its plan and its jobs as counts), Privacy requests, System (Health, Costs, Email, Security reports, Administrators) |

The candidate's pages are listed in [AGENTS.md](../AGENTS.md), "Candidate pages". They are drawn by the API (`apps/api/src/pages/layout.tsx`) and cannot load the app's stylesheet, so their own stylesheet carries a copy of the token values in both themes; `apps/api/src/candidate-look.test.ts` fails if the two drift. Their fonts come only from the deployment's own `/fonts/` folder (`scripts/fetch-fonts.ts` pins the versions and records a SHA-256 for every file in `apps/api/src/pages/fonts.lock.json`), so no font host learns who opened a job page.

## Voice

Warm, direct and specific. An email to a candidate is signed by the company's hiring team and carries the AI disclosure line. Never "perfect fit", "the algorithm says", "rejected by AI", "rockstar" or "ninja", and never a score with no way to see what is behind it: wherever a score shows, its breakdown and the quotes are one click away.

## Words on screen (owner, 23 October 2026)

"Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout."

- **Keep:** the page title (H1) and the section headings; every form field's label; button and link text; status words; counts, figures, dates and names; error, validation and confirmation messages; an empty state's one-line title (its body line only when it says what to do); disclosures that already hide detail ("Why", "More", "How AI is used"); anything the person must act on; what customers wrote. **Always keep what the law or ethics require**, above all on candidate pages: the AI-use disclosure, consent text and boxes, privacy and data notices and links, the accommodation line, pay transparency, "people make every hiring decision", unsubscribe text, anything `packages/core`'s compliance layer writes, and anything a test names as a legal or owner's requirement. When unsure, keep it.
- **Cut:** taglines and slogans; eyebrows that only decorate a title (a company name, "Job · company"); a mono eyebrow stays when it names a section ("AI interview") and nothing else on the card says it, and the rail keeps its Admin label. Also cut a line under a title that only describes the page; helper text that repeats a label or explains the obvious; keyboard-hint lines (the hint moves to the control as `title` and `aria-keyshortcuts`); explanatory paragraphs on staff screens (a rule staff truly need goes behind one disclosure); words repeated elsewhere on screen (the company name in the top bar, a breadcrumb that only repeats the H1, a title repeated under the header, a label under a big number that the card's heading already gives).
- **Fix the layout instead:** an icon with an accessible name (`IconLabel`: the eye for "Candidates see this"); clear groups with one obvious main action each; an example as a placeholder inside a field (never instead of its label); one folded disclosure for a needed explanation; `title` only as a second aid.
- **Navigation keeps the app's words:** Home, Jobs, Candidates, Settings and Start a hire; for a platform administrator Companies, Privacy requests and System.
- **The word people read is "resume"**, never "CV" or "résumé".
- **Tests:** an assertion on words that were cut is updated, and the cut becomes what it checks; assertions on everything kept stay. A required notice is never cut to make a test pass.

## Design system (`packages/ui`)

**Intent.** A warm paper ground, deep plum ink and buttons, one coral spark, lavender and peach tints, soft hairlines, generous white space, big display headings and small mono eyebrows. Calm; urgency is shown by placement and a soft wash, never by alarm colours. The look is our own code: no component library, and nothing copied from coss.com/ui, shadcn or similar kits.

**Stack.** Tailwind CSS v4 through PostCSS builds one stylesheet: the entry is `apps/shell/app/globals.css`, and the look lives in `packages/ui/src/styles.css`, which declares `@source` for `apps/web/src`, `apps/shell/app`, `apps/shell/components` and the kit, its tests left out. Pages combine the kit's classes with Tailwind utilities; `cn()` (clsx + tailwind-merge) joins them so a later utility wins. `pnpm css` (`node apps/shell/scripts/build-css.mjs [out.css]`) builds the sheet without starting the app and prints its size.

**Breakpoints.** Tailwind's named ones (`sm` 640, `md` 768, `lg` 1024, `xl`, `2xl`) plus `rail` (`--breakpoint-rail: 56.25rem`, 900px), the frame's switch from the top bar to the side rail. Write `rail:` and `max-rail:` for it, never `min-[900px]:`: being rem like the others, `rail:` sorts between `md:` and `lg:`, while an arbitrary pixel variant sorts before every named one. The kit's own 900px queries write the same `56.25rem`; `weight-guard.test.ts` checks they match.

**Tokens** (custom properties at the top of `styles.css`, light in `:root`, dark in two identical blocks: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and `:root[data-theme="dark"]`). Tailwind's own palette is switched off: only these colours exist as classes (`bg-surface`, `text-ink-2`, `border-line`, `bg-primary`, `text-good`, `bg-caution-soft`…), and they flip with the theme by themselves, so pages rarely need `dark:`.

| Role | Tokens | Light | Used for |
|---|---|---|---|
| Ground | `--ground`, `--glow-1`, `--glow-2` | warm paper `#faf7f5`, peach and lavender washes | the page |
| Surfaces | `--surface`, `--surface-2`, `--surface-3` | near-white, warm sunken, pressed | cards and fields; table bands, quiet chips, hovered rows; skeletons |
| Tints | `--tint`, `--tint-2`, `--peach` | lavender, deeper lavender, peach | the chosen item and info alerts; icon chips and avatars; the person's own chat bubbles |
| Lines | `--line`, `--line-2`, `--line-tint`, `--line-strong` | hairline, outline, lavender edge, field border (3:1) | dividers; secondary buttons and menus; highlighted cards; inputs |
| Ink | `--ink`, `--ink-2`, `--ink-3` | plum-black, secondary, muted (4.5:1 on every ground) | text |
| Plum | `--primary`, `--primary-hover`, `--on-primary`, `--focus` | `#523267` | primary buttons, links, the chosen tab and nav item; the focus ring |
| Coral | `--accent`, `--accent-ink`, `--accent-soft` | `#db5533` | the logo's "OS", live dots (a mark, 3:1); `--accent-ink` for coral words |
| Signals | `--good`, `--caution`, `--critical`, `--info`, `--warm` with `-soft` fills and `-dot` marks | sage, amber, brick, violet, rust | always beside a word: Open, Draft, a missing must-have |
| Layers | `--scrim`, `--sh-xs`, `--sh-sm`, `--sh-pop`, `--sh-primary`, `--sh-inset` | plum-tinted shadows | Tailwind `shadow-xs/sm/pop/primary` |

`tokens.test.ts` recomputes WCAG AA for both themes, checks that the dark blocks agree key for key and that every colour has a dark value, that every dropdown's open list is coloured by the kit (never `appearance: none`), and the forced-colours rules.

**Type.** Bricolage Grotesque for display, IBM Plex Sans for the interface (400/500/600 only: never bold, which would be faked), IBM Plex Mono for eyebrows, table headings and initials. Figures are tabular. All self-hosted from `/fonts/`.

**Motion.** One easing, `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease`, Tailwind `ease-soft`). Nothing over 320ms. Only `transform` and `opacity` are animated (colours and shadows transition on hover); never width, height or position. Enters are CSS (`animate-enter`, `animate-fade`, and the kit's panels, dialogs, menus and toasts grow or slide in), so they work before hydration. `motion` does what CSS cannot: today only the toast's exit. **Panels, dialogs and menus close at once** (decided 23 October 2026): an exit would keep a closing panel in the page where screen readers and the Tab round would still find it; a leaving toast is `inert`. Use `AnimatePresence` with its default mode or `mode="wait"`, never `mode="popLayout"`, which writes a `<style>` element the content-security policy blocks. Four loops only: the skeleton's shimmer, the Live ring, the typing dots and the spinner. Hover fills wait for a mouse (Tailwind's `hover:` is redefined to `(hover: hover) and (pointer: fine)`), presses wait for `prefers-reduced-motion: no-preference`, and reduced motion stops every animation and transition. No blur, no `backdrop-filter`, no WebGL or canvas. `weight-guard.test.ts` checks all of this, the sheet's byte budget, and that no package lists another styling, animation, component, icon or chart library (Tailwind CSS, PostCSS, motion, clsx and tailwind-merge only).

**Tailwind name clashes.** Tailwind makes a utility of every word in the sources that names one, and utilities beat the component layer. `ordinal` is switched off (`@source not inline`), Button's full-width class is `wide` (not `block`) and SplitView's sticky pane is `keep-in-view` (not `sticky`). The audit is at the top of `styles.css`. Never give an element a hook class that is also a utility's name.

**The kit contract.** `index.tsx` holds the components that use no hook (server components import it): `Button`, `IconButton`, `Card`, `Chip`, `Pill`, `ScoreBadge`, `Avatar`, `Eyebrow`, `PageHeader`, `SectionHeader`, `Field`, `Alert`, `IconLabel`, `IconChip`, `EmptyState`, `ErrorState`, `ProgressSteps`, `Skeleton`, `Segmented`, `Table`, `Icon`. `Drawer`, `Dialog`, `Tabs`, `TabPanel`, `SplitView`, `AutoTextarea`, `Menu`, `Toast`, `Toaster` and `MotionProvider` live in their own `"use client"` files and are re-exported. Every component keeps its props, its markup and its class strings: tests pin many byte for byte. The options screens reach for:

- `className` on `Button`, `IconButton`, `IconChip`, `Eyebrow`, `Alert`, `Pill`, `Chip`, `PageHeader`, `Segmented` and `IconLabel`: added after the kit's own classes with `cn()`. For placement and spacing, not a second look.
- `Card`: `needsYou` (the "Your next step" wash), `hero` (the title at 26px, 30px from 768px, for a page's one next step), `flush` (a list card: rows edge to edge under the title), `lift`.
- `PageHeader hero`: Home's greeting, 36px, 44px from 640px, 52px from 768px. The H1 stays a bare `<h1>`.
- `Button`: `keyshortcuts` (announced, nothing drawn; give it a `title` too), `ariaDisabled` with `describedBy` (greyed, but it can still be pressed to show what is missing), `ariaPressed`, `block` (class `wide`), `loading`.
- `Pill`: tones `neutral good caution critical accent info warm`, `solid`, `pulse`, `busy` (the spinner in the dot's place), `className="wrap"` for a long sentence.
- `ScoreBadge`: the page hands it the number, the band's word and the colour; the kit keeps no band table. `none` gives the words shown instead of a number.
- `Field aside`: a node beside the label (an `IconLabel`). `IconLabel`: the icon alone, its words as `sr-only` text and tooltip.
- `IconChip`: tones `lavender peach plum good caution neutral`, sizes `xs` (28px), `sm`, `md`, `lg`. `Eyebrow as="h2"` or `"h3"`: a section's heading in the eyebrow's look.
- `Table`: `scroll`, `pinFirst`, `wrapHeads`, `loading`, `empty`, a heading that sorts (`sort`, `onSort`, with `nextSort` and `sortRows`).
- `Tabs`: `variant="counts"`, `orientation="vertical"`. `Drawer` and `Dialog`: `size="lg"`.

**Kit classes** (the component layer of `styles.css`; usable on any element, `<Link>` included):

- *Layout*: `stack`, `row`, `grid-2`, `muted`, `small`, `num`, `nowrap`, `details.more`, `link-like`, `text-link`. Plain links inside `<main>` are drawn plum and semibold with a quiet underline, so a link inside bold words still shows.
- *Headers*: `eyebrow` (`eyebrow live` adds the coral dot), `page-header` (+`-row`, `-actions`, `-sub`, `hero`), `section-header`.
- *Surfaces*: `card` (+`card-title`, `needs-you`, `hero`, `flush`, `lift`), `list-card`, rows `list-row` (`-lead`, `-main`, `-title` + `wrap`, `-meta`, `-end`, `chev`), `stat-strip` with `stat-cell` (`-label`, `-value`), `icon-chip`, `ordinal` (the numbered circle), `inline-tag` ("(you)"), `option-row` (a bordered 44px row round a native radio or checkbox), `dl.glance` (label and value rows split by hairlines).
- *Controls*: `btn` (`primary`, `secondary`, `ghost`/`quiet`, `danger`/`destructive`, `sm`, `wide`), `icon-btn` (+`sm`), `toggle-chip[aria-pressed]` (+`.count`), `segmented` (`button.on`), `input`/`textarea`/`select`, `field`/`field-head`/`hint`, `check`, `autogrow`. Touch screens get 40px targets.
- *Signals*: `pill` with `dot`, `chip` (tones, `source`), `score` (`good caution neutral none`, `sm`, `lg`, `.of`, `score-wrap`, `score-band`), `avatar` (`sm lg xl ink square`), `alert` (`info caution critical neutral`, each with a mark drawn by CSS), `empty`/`empty-icon`/`empty-action`, `skeleton`, `spinner`, `steps`.
- *Conversation*: `bubble` (`assistant`, `user`, `system`, `typing` with `dots`, `answers`), `bubble-label`, `composer`.
- *Tables*: `table-wrap` (`scroll`, `pin-first`, `wrap-heads`), `table`, `th-sort`, `table-empty`.
- *Tabs*: `tabs` (+`counts`), `tab`, `tab-label`, `count`, `tab-dot`, `tab-panel`; `.tabs[aria-orientation="vertical"]` runs them down the side.
- *Floating* (each grows or slides in, and closes at once): `menu` (`menu-heading`, `menu-item` + `danger`, `menu-hint`, `menu-reason`), the Drawer's `sheet-backdrop`/`sheet`/`drawer-*`, the Dialog's `dialog-*`, the Toaster's `toast-region`/`toast`, `split`/`split-pane`. Layers: sticky 5, panels 60, menus 70, toasts 80.

A screen's own classes (`builder`, `chat…`) are not styled globally: each screen styles its markup with utilities, and keeps such a class only as a hook a test or script reads.

**Accessibility.** WCAG AA in both themes (checked by test), a visible plum focus ring on everything focusable, labels on every field, live regions for toasts and the conversation, no colour-only meaning (a word goes with every dot; links in text are underlined), reduced motion respected, forced colours kept readable, and nothing scrolls sideways at 360px. Sortable headings say their order with `aria-sort` on the sorted column only.

**The frame** (`apps/shell/components/AppShell.tsx`, its decisions in `apps/web/src/rail.ts`). The side rail, top to bottom: the name, the company chip (your role, a "Switch company" menu for someone in more than one company, a cog to Settings), **Start a hire**, then Home, Jobs, Candidates and Settings. A platform administrator gets Companies, Privacy requests and System instead, under an Admin label when they also work in a company. At the foot: who is signed in, Updates with the unread count, Sign out and the theme switch. The rail folds to icons on a job's own pages or by choice (`ros.rail.collapsed`). Under 900px it becomes a top bar with a **Menu** button.
