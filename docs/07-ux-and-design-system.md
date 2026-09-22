# 07. UX and design system

## The experience in one line

Tell us who you need. We run the process. You decide.

## Owner / Hiring Manager Mode

Primary navigation (docs/FOUNDER-CONTEXT.md §14): **Today, Roles, Talent, Interviews, Offers, Insights**; secondary: Activity, Recruiter help, Integrations, Settings. Views appear as their slices land (Today, Roles, Talent and Setup today; Interviews with Slice 3, Offers with Slice 4, Insights with Slice 9), never as empty menu items.

**Today** answers four questions in one line and then in cards: what needs my attention, who are the best people to look at, what is at risk, what did the system accomplish since I last checked. It is a conversation with the recruiting chief of staff, opened to the morning brief. The brief is a sequence of cards, each with a plain-language headline and one or two actions:

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

Below the brief, the owner types. Replies are short, cite records with links, and end with an action when there is one. Every action that requires approval is a card, never a sentence that pretends it happened.

**Roles.** One row per role: title, days open, a five-segment pipeline bar (applied · screened · interviewing · deciding · offer), and "what needs you." Opening a role shows the packet summary, the pipeline, and the posting status per channel with plain-language status ("Live on your careers page and Google. Indeed: post it from your account and forward applications to this address" with a copy button).

**Talent.** For a role: a list of candidates grouped by "waiting on you," "in process," "not moving forward." Each row: name, overall (Strong match / Potential match / Weak match / Insufficient evidence), two strengths, one concern, confidence. "Not moving forward" is the exclusion view: reason, evidence, policy applied, and "Review anyway" for anything an eligibility rule declined. Nothing is hidden. Compare mode: up to four candidates side by side by competency with evidence expandable. No numeric score is shown by default; a recruiter can enable the secondary score.

**Calendar.** Interviews this week with briefs, interviewer load, and unscheduled interviews waiting on candidates.

**Setup.** Company profile, team and roles, integrations with status badges, "What the AI may do on its own" (the policy editor, grouped by lifecycle stage with the four levels as a segmented control), notices and consent texts (with the jurisdictions they apply to), billing and usage.

**Bring in a recruiter** is a persistent button in the conversation and on every decision card. It opens a short sheet: "What do you want help with?" with three quick picks (Review these candidates · Help me decide · Take this role over) and a free-text box, then confirms the SLA.

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

## Voice (docs/FOUNDER-CONTEXT.md §18)

One personality, the recruiting chief of staff: concise and decisive for employers ("Three candidates need your review. I recommend advancing two. Here is why."), collaborative and evidence-based with hiring managers, warm and specific with candidates, transparent everywhere. Never: "perfect fit", "culture fit" without a definition, "the algorithm says", "rejected by AI", "human capital", "resource", "rockstar", "ninja", or anything that reduces a person to a score.

## Design system (`packages/ui`)

Palette (§19): a neutral base with one electric accent (cobalt, `--accent`) and one warm supporting tone (`--needs-you`); semantic good/caution/critical are separate from the accent and never the sole carrier of candidate quality. No purple gradients, no teal-only HR palette.

**Intent.** Modern, trustworthy, premium, extremely simple. Not a legacy ATS: no dense grey grids by default, no stage-name jargon in Owner Mode, no red-green-yellow traffic lights as the primary signal. The product is calm; urgency is communicated by placement (top of the brief) and by a single accent, not by alarm colors.

**Tokens** (CSS custom properties, light and dark):

- Color: a near-white ground with a slight cool bias; ink at 90% contrast; one accent (deep green) for primary actions and progress; a warm secondary for "needs you"; semantic colors for success, caution, and error used only in status chips and alerts, never as decoration. Evidence-source chips use muted tints.
- Type: a characterful grotesk for headings (Bricolage Grotesque), a humanist sans for UI (IBM Plex Sans), tabular numerals in tables. Sizes on a 1.2 scale from 12 to 32. Line height 1.5 for reading, 1.25 for UI.
- Spacing: 4-pixel base; components use 8/12/16/24/32.
- Radius: 6 for controls, 10 for cards. Shadow only on the one element that needs lift (a sheet, a menu).
- Motion: 150 to 200 ms ease-out; respects reduced motion.

**Components.** Button (primary, secondary, quiet, destructive; loading and disabled states), Input, Textarea, Select, Segmented control, Checkbox with consent variant, Card, Candidate card, Approval card, Conversation card (assistant, user, system), Evidence chip (source), Assessment block (overall, strengths, concerns, unknowns, confidence), Scorecard (competency rows with rating and evidence), Timeline (events with actor icons), Status chip (stage in plain language), Pipeline bar, Table (dense variant for Recruiter Mode), Sheet (side panel), Dialog, Toast, Alert (info, caution, error), Empty state (illustration-free, one sentence, one action), Loading state (skeletons, never spinners in content), Error state (what happened, what to do, retry).

**Accessibility.** WCAG AA contrast, keyboard operability for every action, focus rings, labels on every input, live regions for the conversation, no color-only meaning.

**Mobile.** Owner Mode and the candidate experience are designed at 375px first; Recruiter Mode is desktop-first with a usable phone view for the queue.
