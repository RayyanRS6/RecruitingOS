# 07. UX and design system

## The experience in one line

Tell us who you need. We run the process. You decide.

## Owner / Hiring Manager Mode

Primary navigation (docs/FOUNDER-CONTEXT.md §14): **Today, Roles, Talent, Interviews, Offers, Insights**; secondary: Activity, Recruiter help, Integrations, Settings. Views appear as their slices land (Today, Roles, Talent and Setup today; Interviews with Slice 3, Offers with Slice 4, Insights with Slice 9), never as empty menu items.

**Today** answers four questions in one line and then in cards: what needs my attention, who are the best people to look at, what is at risk, what did the system accomplish since I last checked. It opens to the morning brief, a sequence of cards, each with a plain-language headline and one or two actions:

| Brief section | Card | Primary action | Secondary |
|---|---|---|---|
| New applicants | "12 people applied to Dental Hygienist since yesterday. 4 look strong." | Review the 4 | Show all |
| Top candidates | Candidate card: name, one-line summary, two strengths, one concern, confidence, evidence source chips | Interview | Pass · Ask a recruiter |
| Candidates needing review | "3 applicants need a human look (unclear license status)." | Review | |
| Interviews today | "Maria R., 2:00pm with you and Dr. Chen. Brief attached." | Open brief | Reschedule |
| Decisions needed | Approval card: "Approve the offer to Maria: $52/hr, starts Oct 6." | Approve | Edit · Ask a recruiter |
| Offers | "Offer to Jonah sent Monday, viewed twice, no response." | Nudge | Call him (recruiter) |
| Candidates at risk | "Two strong candidates have waited 4 days for a decision." | Decide now | |
| Roles stuck | "Front Office Coordinator: 5 screened, no interviews scheduled in 6 days." | Schedule them | Have a recruiter review |
| Upcoming starts | "Maria starts Monday. Two things need you." | Open checklist | |

Below the brief, people who may start a hire see **Who are you hiring?**: what they type (a sentence, or a whole job ad) opens the job builder on a new draft, and each of their drafts in progress shows as a card with Continue and Discard. Every action that requires approval is a card, never a sentence that pretends it happened.

**Job builder** (`/roles/new`, plan Wave C; reached from Today, **Start a hire** in the rail and Roles, never a new menu section). A split view: the conversation on the left, the draft on the right (one at a time on a phone, with a switch). The assistant asks with up to three tap-to-answer question cards docked where the message box is (pick one, pick any, team members, the pay card), each with "Why we ask"; the picks go back into the conversation as one plain summary. The draft fills in as the person answers; each section says who sees it (candidates, asked of candidates, used to review applications but not on the job page, or only the team). "Write the draft" shows the real steps as the server records them. After that, typed words ask for a change, shown field by field and saved only on Confirm. Wording the fairness check flags waits for a person: change it, or keep it with a reason the approver sees. "Ask for approval" stays greyed, listing in the server's words what is missing, until the draft is written, up to date with the answers, and complete. When the assistant fails, "Bring in a recruiter" hands over the draft and its conversation.

**Roles.** One row per role: title, days open, a five-segment pipeline bar (applied · screened · interviewing · deciding · offer), and "what needs you." Drafts in progress are listed above the roles (owners and admins also see the team's, to pick one up). Opening a role shows the packet summary, the pipeline, and the posting status per channel with plain-language status ("Live on your careers page and Google. Indeed: post it from your account and forward applications to this address" with a copy button).

**Talent.** For a role: a list of candidates grouped by "waiting on you," "in process," "not moving forward." Each row: name, overall (Strong match / Potential match / Weak match / Insufficient evidence), two strengths, one concern, confidence. "Not moving forward" is the exclusion view: reason, evidence, policy applied, and "Review anyway" for anything an eligibility rule declined. Nothing is hidden. Compare mode: up to four candidates side by side by competency with evidence expandable. Candidates get a 0-100 match score worked out by code from checked evidence against the role's must-haves (never written by the AI), with its breakdown of what cost points one click away wherever the number shows, and with missing information set aside rather than counted against them; a person always decides. The score's bands have their own words (Very high, High, Medium, Low) so they are never confused with the AI's overall reading above.

**Calendar.** Interviews this week with briefs, interviewer load, and unscheduled interviews waiting on candidates.

**Setup.** Company profile, team and roles, integrations with status badges, "What the AI may do on its own" (the policy editor, grouped by lifecycle stage with the four levels as a segmented control that offers only the levels an action allows), notices and consent texts (with the jurisdictions they apply to), billing and usage.

**Bring in a recruiter** is a persistent button in the conversation and on every decision card. It opens a short sheet: "What do you want help with?" with three quick picks (Review these candidates · Help me decide · Take this role over) and a free-text box, says what the recruiter will see and until when, then confirms the SLA. Opened from the top of Today (no role or candidate in view), it first asks "Which hire is this about?" (a role, or All of your hiring) and needs a one-line note.

## Recruiter Mode

A permission set that adds routes and density:

- **Pipeline table** per role with stage columns, filters, bulk actions (invite to screen, send message, move, reject with reason), and keyboard navigation.
- **Search** across the tenant's candidates and documents (full text plus similarity), with saved searches.
- **Candidate workspace**: timeline of every event, all assessments with evidence, screen transcript, interviews and scorecards, communications thread with reply, notes, tasks, compensation, and the audit strip.
- **Scorecards and rubric editing** on the packet (creates a new packet version).
- **Sequences and communication controls**: templates, sending windows, channel rules.
- **Workflow controls**: view runs for a role, pause, retry a step, override with reason, take over.
- **Multi-client switching** for ITS recruiters, with the escalation queue as their home.

Recruiter Mode never shows a candidate anything the owner cannot see; it shows more of the machinery.

## Candidate experience

- **Job page**: title, pay range (shown when the packet allows; required by law in some states, handled by the compliance layer), location, schedule, a plain description, "what to expect" with the steps and typical timeline, the AI disclosure, and one button.
- **Apply**: name, email, phone (with a separate, unchecked SMS consent box), resume upload or four short questions, the eligibility questions in plain language, the state-appropriate notices, and a confirmation with a status link. Under three minutes on a phone.
- **Screen**: text or web chat, one question at a time, progress ("3 of 7"), pause and resume, "talk to a person" always visible.
- **Schedule**: tap a slot; confirmation with calendar file; reschedule and cancel links.
- **Interview prep**: who they will meet, format, length, what to bring, the case prompt if any.
- **Status**: where they are, what happens next, when they will hear; withdrawal in one tap.
- **Offer**: the letter, a place to ask questions, signature, a countdown to day one.
- **Privacy**: a page explaining what is stored, for how long, and how to request access or deletion.

Tone: warm, direct, specific. Signed by the company's hiring team, "assisted by an AI recruiter." Never "I" from the AI without the disclosure line present.

**The same look as the application.** The candidate pages are server-rendered by the API (`apps/api/src/pages/layout.tsx`) and cannot load the application's stylesheet, so their inline stylesheet carries a copy of the token values in `packages/ui/src/tokens.css`, in both themes. `apps/api/src/candidate-look.test.ts` fails if the two drift, so changing a colour in `tokens.css` means changing the copy in `layout.tsx` too. The buttons follow the same rules (a near-black primary, outlined secondary ones), with small uppercase eyebrows and pills for a job's facts. The fonts (IBM Plex Sans 400 and 600, Bricolage Grotesque 700) are asked for only from the deployment's own origin (`/fonts/`, served from `apps/shell/public/fonts`), so the pages' content-security policy names no outside host and no font host learns who opened a job page. The files are put there by `scripts/fetch-fonts.ts`, which pins exact package versions and records a SHA-256 for every file in `apps/api/src/pages/fonts.lock.json`; until they are committed the pages use the device's own sans-serif.

## Voice (docs/FOUNDER-CONTEXT.md §18)

One personality, the recruiting chief of staff: concise and decisive for employers ("Three candidates need your review. I recommend advancing two. Here is why."), collaborative and evidence-based with hiring managers, warm and specific with candidates, transparent everywhere. Never: "perfect fit", "culture fit" without a definition, "the algorithm says", "rejected by AI", "human capital", "resource", "rockstar", "ninja", or anything that reduces a person to a score (wherever the match score appears, on a row, a card or the candidate panel, its breakdown and the evidence behind it are one click away).

## Design system (`packages/ui`)

**Intent.** Modern, trustworthy, premium, extremely simple: a quiet, paper-like workspace where the words and the people stand out, not the chrome. Not a legacy ATS: no dense grey grids by default, no stage-name jargon in Owner Mode. The product is calm; urgency is communicated by placement (top of the brief), not by alarm colours. The founder chose this look in October 2026 (a warm off-white ground, white cards with hairline borders, near-black type and buttons); it is our own identity, with our own names, wording and wordmark, and no illustrations.

**Palette.** Everything lives in `packages/ui/src/tokens.css` as CSS custom properties, with a light and a dark theme. The dark theme follows the device setting (`prefers-color-scheme`) unless the page sets `data-theme="light"` or `data-theme="dark"` on `<html>`. Each colour's contrast ratio is written beside it, and `tokens.test.ts` recomputes the important pairs in both themes so a change cannot quietly drop below WCAG AA.

| Role | Token | Light | Used for |
|---|---|---|---|
| Ground | `--ground` | warm off-white `#f7f5f0` | the page |
| Surface | `--surface` | white | cards, lists, the drawer header, menus |
| Sunken | `--surface-2`, `--surface-3` | warm greys | neutral chips, hover, the grey score badge |
| Rail | `--surface-rail` | a touch lighter than the ground | the left rail |
| Hairline | `--line`, `--line-2` | warm light greys | borders between surfaces; outlines of secondary buttons and pills |
| Field border | `--line-strong` | `#8c8578` (3.7:1) | inputs, selects and text areas, which must be seen (WCAG 1.4.11) |
| Ink | `--ink`, `--ink-2`, `--ink-3` | near-black, dark grey, muted grey (5.5:1 at the lightest) | text: titles, body, secondary lines |
| Primary | `--primary`, `--primary-hover`, `--on-primary` | near-black with white text | the one main action on a screen; in dark mode it turns light with dark text |
| Links and focus | `--link`, `--focus` (`--accent-ink`, `--accent`) | cobalt | links and focus rings only, nothing else |
| Good | `--good`, `--good-soft`, `--good-line`, `--good-dot`, `--good-solid` | green | positive, live, match score 70 or more, the solid "Hired" pill |
| Caution | `--caution`, `--caution-soft`, `--caution-line`, `--caution-dot` | amber | middling, on hold, needs a closer look, match score 55-69 |
| Critical | `--critical`, `--critical-soft`, `--critical-line`, `--critical-dot` | red | only a missing must-have or a critical error |

Signal colours always sit next to a word (a dot and "Live", a tick and "done"); colour is never the only carrier, and a low match score is plain grey, not red. The earlier token names still work and point at the new values: `--bg` is the ground, `--bg-2` the surface, `--bg-3` the sunken grey, `--needs-you` is the caution amber, `--shadow` is the floating shadow, and `--accent`/`--accent-ink`/`--accent-soft` are the cobalt link colours.

**Type.** Bricolage Grotesque for headings, IBM Plex Sans for everything else, IBM Plex Mono for code. Sizes `--text-xs` 12 to `--text-2xl` 28 (page titles). Line height 1.5 for reading, 1.25 for UI. Counts, scores, dates and tables use tabular numerals (`.tabular`) so columns line up. Above a page title sits an eyebrow: small, uppercase, widely letter-spaced, muted ("Role · Bright Dental", "Editing"); it is written in normal case and raised by CSS, so screen readers read it normally.

**Space, shape, depth, motion.** A 4-pixel base: `--space-1` 4 to `--space-8` 64. Radius `--r-control` 8 (buttons, fields), `--r-card` 12 (cards, menus), `--r-panel` 16, `--r-pill` for pills. Shadows only on floating layers (the drawer, menus, dialogs, toasts: `--shadow-float`); cards are flat with a hairline border. Motion 150-200 ms with `--ease`; with reduced motion asked for, every animation and transition is switched off. Layers: sticky headers `--z-sticky`, drawer `--z-drawer`, menus `--z-menu`, toasts `--z-toast`.

**Components** (`packages/ui`). `index.tsx` holds the ones without state, safe to use from server components; the ones that listen to the keyboard or keep state live in their own client files and are re-exported from the same place.

- *Button*: primary (near-black), secondary (white, outlined), ghost (no box), danger (soft red, only for actions that cannot be taken back); `quiet` and `destructive` are the earlier names for ghost and danger. Optional leading or trailing icon, a keyboard hint (`kbd="N"`, also announced as the shortcut), a working state (a small spinner and "Working…") and disabled. *IconButton* is an icon alone, always with a spoken label that also shows as a tooltip.
- *Icon*: our own line drawings on a 24-pixel grid, drawn in the text colour: today/home, roles/briefcase, talent/people, interviews/calendar, settings, plus, minus, search, the four chevrons, check, check-circle, x, sparkle/assistant, mail, send, upload, paperclip/attach, mic, eye, edit/pencil, clock, alert, info, help, lock, link, share, filter, sort, more, arrow-left, arrow-right, user, building, star, flag, refresh, external, copy, log-out/sign-out, menu, message, grid. Decorative unless given a label.
- *Avatar*: initials in a circle ("Priya Raman" → PR), sizes sm/md/lg/xl, neutral grey or filled ink (the company and the signed-in person), square for a company. Never a photo for a candidate.
- *Pill*: a status dot and a word, tones neutral, good, caution, critical and accent (accent is ink-outlined, for "in process"); `solid` for a finished state (Hired) and `pulse` for something live. *Chip* is the smaller label for facts and evidence sources. *StatusChip* shows an application's plain-language status as a pill.
- *ScoreBadge*: the match score as "91/100", green from 70, amber 55-69, grey below; screen readers hear "Match score 91 out of 100"; with no score yet it says "No score yet". Bands in our words: Very high 85+, High 70+, Medium 55+, Low below. They describe the number the code worked out and never reuse the AI reading's words (Strong match, Potential match, Weak match, Insufficient evidence), so the two cannot be mistaken for each other on one screen (`helpers.test.ts` checks this). A large version shows the number on its own for the candidate panel.
- *StageButton*: the stage pill on a candidate's row and panel header, in the stage's colour with its dot and word, that opens "Move to stage" with the eight owner stages (New, Longlist, Shortlist, Interviewing, On hold, Offer, Hired, Not moving forward; `OWNER_STAGES` in `helpers.ts`). The current stage is marked; a move that is not allowed right now stays in the list, greyed, with its reason. Never red: a decision is not an error. The page decides what each choice does (set a mark, open the interview card, the private decline).
- *Eyebrow* and *PageHeader*: eyebrow, title, a status pill beside it, actions on the right, and a line underneath ("6 applicants · closes in 3 weeks"); a title not chosen yet ("Untitled role") shows in grey italics.
- *Tabs*: underlined, keyboard accessible (arrows, Home, End; disabled tabs are passed over), optional counts; the `counts` variant puts the number above the word for the stage strip. *TabPanel* holds the chosen tab's content when the panel sits apart from the tabs (in a drawer body).
- *Drawer*: the right-hand panel for a candidate or an interview: a sticky white header with an optional avatar, the title, a line under it, actions (a message button, the stage button) and an optional tab row, over a scrolling body. Escape closes it, Tab stays inside it, the page behind does not scroll, and closing puts focus back where it was. With a sheet opened from inside a drawer, only the top one answers Escape and Tab, and the page scrolls again once the last one closes, whatever order they close in (one shared hold, `holdPageScroll` in `helpers.ts`). *Sheet* is the same panel with only a title.
- *Dialog*: a calm confirmation in the middle of the screen (the screen right after a role is approved): an optional decorative mark at the top (a green tick once something is done), the title, a line under it, the body, and the buttons at the foot, which stay in view. The same keyboard rules as the Drawer; on a phone it rises from the bottom and the buttons share the width.
- *SplitView*: two panes side by side (the conversation and what it is building). Under 900px a switch above them flips between the two.
- *Menu*: a button that opens a list of choices, for the stage button: each choice can carry a coloured dot, the current one is marked, and a choice that is not allowed right now stays visible, greyed, with the reason underneath.
- *Toast* and *Toaster*: a dark note at the bottom of the screen with a title and, when there is more to say, a second line about what did or did not follow ("Moved to Shortlist." / "Private: the candidate was not told."). It stays longer for longer messages. Pages call `toast(title, detail)` from `apps/web/src/toast.ts`; the Toaster is mounted once by the shell.
- *ProgressSteps*: a short ticked list for work under way ("Writing the job description ✓", "Updating the draft…"), each state also spoken.
- *Kbd*: a keyboard hint ("N"). *EmptyState*: one sentence on why the place is empty and at most one clear action, with an optional icon and no illustrations.
- Also: Card, Field, Alert (neutral, info, caution, critical), Segmented control (the chosen option is near-black), Skeleton, Error state, Timeline, Pipeline bar, Table, conversation Bubble (the person's messages near-black on the right, the assistant's white on the left).

**Layout classes** in `tokens.css` for the shell and lists: `.shell` with the `.rail` (optional `.rail-org` company chip, `.rail-start` "Start a hire" button with its key hint, `.rail-sub` list of roles under Roles with a `.dot` per role, `data-rail="compact"` on `.shell` for the icon-only rail on a role's own pages), `.main` (add `.full` for a page that needs the whole width), `.list` and `.list-item` for rows of people (avatar, name and a line under it, then the stage, score and an arrow on the right, wrapping below on phones), and `.pill-button` for a pill that opens a menu. The rail's link rules leave `.icon-btn` links alone (the company chip's cog). A few shell-only pieces (the phone Menu, the person at the foot of the rail, Setup's section menu) live in `apps/shell/components/app-shell.css`.

**The rail** (`apps/shell/components/AppShell.tsx`, decisions in `apps/web/src/rail.ts` and `apps/web/src/start-hire.ts`):

- *Company chip*: the company, the person's role in it ("ITS recruiter, limited access" under a grant) and a cog to Setup.
- *Start a hire*: near-black, for the people who may start one (`role.create`). It opens the new-role conversation on Today; nothing is saved until the first message is sent. Pressing **N** anywhere outside a text field does the same, except over an open dialog or menu and on a page where something was typed, ticked or chosen (leaving would throw it away; the button still works there). Because a one-letter key can be set off by speech input or a stray press, Setup's "Keyboard shortcut" card turns it off for that browser (WCAG 2.1.4).
- *Roles in progress* under Roles, at most eight, then "All roles": open roles first with a green dot and the number of applicants, then paused, waiting for approval and draft roles with a grey dot, newest first. Each is announced with its state, since the dot and the number are only seen. An interviewer's list comes from the API already limited to the roles they interview for and without counts. An ITS recruiter working inside a customer under a grant gets no list at all: every request they make is recorded for the customer as a page they opened, and the rail would add one on every page load. The list refreshes when a page changes a role and every two minutes while the tab is in view; opening another customer from the recruiter queue empties the cache and redraws the frame, so nothing from the previous company stays on screen.
- *Folding*: on a role's own pages (`/roles/<id>` and below) the rail folds to a column of icons. Under 900px it becomes a top bar: the brand line, Start a hire, a **Menu** button and Sign out stay in the bar, and the links (with the section names and the roles in progress) open below it from Menu. Following a link or pressing Escape closes it.

**Setup's section menu**: a sticky list beside the cards on wide screens, a sticky row that scrolls sideways on phones, listing only the cards the person sees (`apps/web/src/setup-sections.ts`); the card in view is marked. Page eyebrows give context the title does not (the company's name over "Roles", "Job · Bright Dental" over a role's title) and never repeat the title.

**Loading.** Skeletons for content that is on its way; a spinner appears only inside a button that is working or beside a step that is under way.

**Accessibility.** WCAG AA contrast (checked by test for both themes), keyboard operability for every action, a visible cobalt focus ring, labels on every input, live regions for the conversation and for toasts, no colour-only meaning, reduced motion respected.

**Mobile.** Owner Mode and the candidate experience are designed at 375px first; Recruiter Mode is desktop-first with a usable phone view for the queue.
