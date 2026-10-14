# Kanvis reverse-engineering reference (Phase Two)

*Written 14 October 2026 on branch `kanvis-reaudit` (from `origin/main` at `dafb730`). It brings together the Kanvis research of 7 October 2026 and the re-check of 14 October 2026. It stands on its own: you do not need the research notes to read it.*

**Who it is for.** The founder: each section starts in plain words. Engineers: the Evidence columns name the exact Kanvis page, route or shipped code file that each claim rests on (the key is in section 2.6).

**What it does not do.** It does not reopen any decision. The founder's Kanvis-related choices of 7 October 2026 (B1 to B7 and Q2 to Q33) were built and merged in PR #26 on 11 October 2026. Later choices are also recorded and built: cancelled interviews (9-10 Oct), the clean visual style (10 Oct), the two AI models (13 Oct) and the fairness rules (13 Oct). Where Kanvis behaviour touches one of those choices, this document names it as a reference point only ("Touches our decisions").

**Words.** Kanvis's own words are quoted to describe Kanvis. Our product keeps its own words (for example, the score bands in `docs/spec/22-match-score-and-pool-board.md` §1 and §5). Quotes are kept short.

**Names.** Acme Pay, Maya Iqbal, Priya Raman, Tom, Adaeze, Ben, Lena and Sam are made up by Kanvis for its public demo. Real public candidate profiles were opened only to check the page format; their owners are not named here. The founder's own Kanvis candidate account is called "the founder's candidate account".

## Contents

1. [Summary](#1-summary)
2. [Method and evidence labels](#2-method-and-evidence-labels)
3. [What changed between 7 and 14 October](#3-what-changed-between-7-and-14-october-2026)
4. [Recruiter journeys](#4-recruiter-journeys)
5. [Candidate journeys](#5-candidate-journeys)
6. [Interaction design patterns, and why Kanvis feels simpler](#6-interaction-design-patterns-and-why-kanvis-feels-simpler)
7. [Feature checklists A, B and C](#7-feature-checklists-a-b-and-c)
8. [Route and screen inventory](#8-route-and-screen-inventory)
9. [Open questions that still need an account or an application](#9-open-questions-that-still-need-an-account-or-an-application)

---

## 1. Summary

### 1.1 What Kanvis is

Kanvis (https://www.kanvis.me) is a two-sided hiring product from a small company in Lahore, Pakistan, founded in 2026. Its hiring side went live on 29 May 2026 (its terms of use). Most roles on its job board are in Pakistan.

| Side | Who uses it | What they get |
|---|---|---|
| Candidates (free, with no paid tier, per its pricing) | Job seekers | A public profile page at kanvis.me/<name>, built from a CV and a short chat with an AI assistant. An AI "Twin" that answers visitors' questions about the profile. Career tools: a one-page résumé, a cover letter, an outreach message and a job-fit check. A job board. And **applying by talking**: pressing Apply starts a short text interview run by Kanvis's own AI. |
| Hiring teams (Kanvis calls every seat a "recruiter"; Free to $899 a month) | Company owners and their teammates | A workspace to open a role (tap through the facts, then the AI writes the post) and publish it. Every applicant is interviewed by Kanvis's AI as part of applying, then scored 0 to 100. A **Decision board** sorts the pool into Shortlist, Longlist and Pass, each person with a reason and a next step. **Review & apply** files everyone into a private pipeline in one go and emails nobody. **Ask AI** answers questions about the pool. Then a private 10-stage pipeline, AI-drafted emails that a person sends, analytics, share links and a comparison report. |

Kanvis's pitch to hiring teams: "You spend your day deciding, not screening." It says it replaces the first screen only and needs no move away from an existing applicant tracking system. By its own comparison table it does no sourcing and has no integrations.

### 1.2 What we could inspect, and what we could not

| We could see | We could not see |
|---|---|
| Every public page: home, hiring-team landing page, pricing, changelog, job board, job pages, people directory, public profiles, and (on 7 Oct) the legal documents. | Any real hiring-team screen. Hiring-team access is by waitlist only, and we have no hiring-team account. |
| The sitemap, robots.txt and llms.txt files. | A real application or AI interview. Apply was never pressed. |
| The program code Kanvis sends to every visitor's browser, read as text and never run. It holds the real screen wording, but nobody watched it run. | Any AI output. No résumé, letter, job-fit report, Twin answer or chat reply was generated. |
| The public interactive demo, driven by hand on 7 and 14 October. It uses Kanvis's real screens and words with made-up data. | The emails Kanvis sends to candidates or hiring teams. |
| The founder's candidate account: on 7 Oct while her profile was being built in it, on 14 Oct read-only. | Anything on Kanvis's servers: scoring rules, AI instructions, the database. |

### 1.3 Headline: Kanvis has shipped nothing new since 7 October

- The site is still served from the same deployment (`dpl_CXNGXfzLmQpDVX7Lp52pcab9uy9u`). Its program files have the same names, and those names are made from the files' contents. Three files downloaded again on 14 October are byte-for-byte identical, and nine public pages are identical. The changelog's last entry is still 28 September 2026.
- So everything "new" from 14 October is either a re-confirmation or code we read for the first time. None of it is a new Kanvis feature.
- Only data changed: two new jobs, two jobs gone, one job closed by its deadline, 38 new public profiles and two new company logos (section 3).

### 1.4 Ten things worth knowing

1. **The real "New job" is a 10-step tap-through, not a chat box.** The demo starts with "What are you hiring for?", but that prompt exists only in the demo's code. The product asks ten short tap questions (or pre-fills them from a dropped job description), writes the post, and only then offers a chat to refine it. (INFERRED, section 4.3)
2. **Kanvis's own AI interviews every applicant as part of applying.** So, from the hiring team's seat, every applicant arrives already interviewed and scored. (Promises OBSERVED; the interview itself INFERRED, section 5.3)
3. **The number comes from fixed rules; the AI writes the words.** That is Kanvis's claim. The screen shows the points each requirement cost. (Display OBSERVED in the demo; method INFERRED, section 4.6)
4. **One pass decides the pool.** The board proposes; everyone starts ticked; untick anyone to look at yourself (in the demo only Lena can be unticked); one button files them privately and nobody is emailed. (OBSERVED in the demo, section 4.7)
5. **Privacy is said out loud on every move**: "Private — the candidate wasn't notified." (OBSERVED in the demo on "Move to Hired", the only move it allows; that every move says it is INFERRED, section 4.9)
6. **Candidates see a simpler, separate status**: Applied, Interview, Scored, Recruiter review, then Shortlisted or a gentle "Outcome". They also see their own fit score. (INFERRED, section 5.4)
7. **The hiring-team product is small.** Two roles (Owner and Member), four sidebar items, one settings page. There are no approvals, no interview scheduling, no integrations and no billing screens. (INFERRED from what the code lacks, section 4.12)
8. **Every AI failure falls back to doing it yourself**, with calm error lines such as "Your account is fine." (INFERRED, section 6)
9. **Some promises are not met on screen.** Profile claims show no evidence links. Closed jobs still look open on the board. Screening questions never appear on real job pages, although the demo shows them. (OBSERVED, sections 3 and 6.3)
10. **We still cannot see the real hiring-team product.** Access is waitlist-only (OBSERVED). Section 9 lists what an account would answer.

### 1.5 Kanvis's people, next to ours

| Kanvis person | What they can do | Nearest person in Recruiting OS | Label | Evidence |
|---|---|---|---|---|
| Owner (hiring-team seat) | Everything, including company setup (forced on first sign-in) and the team list | owner | INFERRED | [guards-js] [settings-js] [r-terms] §2 |
| Member (hiring-team seat) | Works on jobs and applicants; cannot open company setup. Every seat holder sees all of the company's applicant data. Which other actions are owner-only (publish, close, decide) is not stated anywhere. | hiring manager, HR and interviewer at once: Kanvis has no separate roles, no approvals and no interviewer-only view | INFERRED (rules); UNKNOWN (exact limits) | [guards-js] [r-terms] §2; [sweep]: only the role values OWNER and MEMBER exist |
| Candidate | Profile, tools and applications. One sign-in identity is either a candidate or a hiring-team seat, never both. | candidate | OBSERVED (route guard); INFERRED (terms) | [cand]; [r-terms] §2; [terms] §3C |
| Kanvis staff | Approve the waitlist, create the company and its first owner, "set up the first role with you", give support | ITS recruiter, except that Kanvis staff work outside the product; no in-product "ask a recruiter" exists | INFERRED | [waitlist] [recruiter] [r-terms] §2 |
| Platform admin | Never seen. The code switches off analytics on an /admin path, which suggests an internal admin area. | platform admin | INFERRED | [candroutes-js] |

---

## 2. Method and evidence labels

### 2.1 The four labels

| Label | Meaning | Typical source |
|---|---|---|
| **OBSERVED** | Seen on 14 Oct 2026: on a live page, in the demo, or in the founder's candidate account. | Live page; demo; candidate account |
| **OBSERVED-EARLIER** | Seen on 7 Oct 2026 and not re-checked on 14 Oct. Nothing shipped in between, so it very likely still holds. | 7 Oct live session |
| **INFERRED** | Read in the code Kanvis ships (real product wording, but nobody watched it run), or in Kanvis's own marketing, changelog or legal text. | Code; changelog; terms |
| **UNKNOWN** | Public evidence does not settle it. | n/a |

Two reading rules:

- **The demo shows real screens with made-up data.** The demo's footer says the company is invented but the screens, labels and verdict words are the product's own. So "OBSERVED (demo)" proves what a screen looks like and says. It does not prove how the real product behaves with real applicants. Many demo controls do nothing; section 4 says which.
- **Kanvis describing its own behaviour counts as INFERRED**, even when we read the page that day. For example, "a job closes at the end of its deadline day" is INFERRED from the changelog. That the Uplift AI job page now reads "Applications closed" is OBSERVED.

### 2.2 Sources

| Source | What it is | When | What it can prove |
|---|---|---|---|
| Public pages | Home, /recruiter, /what-is-kanvis, /pricing and /pricing/recruiters, /whats-new (the changelog: about 110 entries from 16 May to 28 Sep 2026), /recruiter/waitlist, /jobs and job pages, company careers pages, /people and public profiles | 7 Oct (six reading passes) and 14 Oct (63 requests) | What anyone can see |
| Site files | sitemap.xml (454 addresses on 7 Oct, 492 on 14 Oct), robots.txt (the pages Kanvis hides from search engines), llms.txt (Kanvis's own summary for AI tools) | both | The route list; what is private |
| Shipped code | The JavaScript files at `https://www.kanvis.me/_next/static/chunks/<name>.js`, read as text with search tools and never run | about 100 files on 7 Oct; 39 on 14 Oct (36 for the first time); 139 in total | Real screen wording, routes, step lists and error lines. A feature's absence holds only for these 139 files: code loaded later could hold more. |
| Legal | Recruiter terms and data processing agreement (dated 5 Aug 2026), terms and privacy policy (dated 19 Aug 2026) | 7 Oct | Kanvis's stated rules |
| Interactive demo | /recruiter/demo: a five-chapter film. Chapters 03 to 05 can be clicked after "Take it from here". | 7 and 14 Oct, by hand in Brave | Real screens and words; what the demo lets you do |
| Founder's candidate account | Already signed in, in the founder's own Brave browser; one new tab. On 7 Oct the notes record her profile being built in it (CV upload, builder chat, choosing the username); on 14 Oct it was read-only | 7 and 14 Oct | The candidate workspace, tools, settings, job matching, and the profile's owner view |

The working notes and downloaded copies from both rounds live outside the repository, in the research sessions' scratch folders. This document does not depend on them.

### 2.3 Safety limits we kept

The first two limits held on both days. The rest describe the 14 October session; on 7 October the founder's profile was built in her candidate account (a CV went in and the builder's AI chat ran), and that is where the OBSERVED-EARLIER builder findings in section 5.5 come from.

- **No hiring-team account.** The waitlist form was read, never sent.
- **Never applied.** "Apply for this role" and "Apply with your profile" were reached and not pressed.
- **No AI generation.** No résumé, cover letter, outreach message, job-fit report, Twin answer or workspace chat reply was triggered.
- **No forms submitted, no messages sent, no settings changed.** Nothing was uploaded, and the résumé PDF was not downloaded. Settings were opened and read only. We did not sign in or out.
- **The demo is a sandbox.** On 14 Oct two neutral test lines with no personal data were typed into the demo's pre-written "Ask AI" box. The demo's analytics may have recorded them.
- **No server calls.** The public pass made plain page requests 1 to 2 seconds apart. It made no calls to Kanvis's /api or /ingest addresses and ran no Kanvis code.
- **Personal data.** New public profiles were counted, not named.
- **No instructions followed.** No text on any Kanvis page addressed the AI assistant or asked it to do anything.

### 2.4 "Who decides"

Each journey says who makes each call:

- **user**: the person at the screen (a hiring-team member or a candidate) presses the button;
- **code**: fixed rules that give the same answer every time;
- **AI**: a language model's judgement or wording (Kanvis names Google Gemini as its only AI provider, [dpa] Annex 3);
- **external**: someone or something outside the product, such as Kanvis staff, Google, LinkedIn or the email provider.

### 2.5 The REA toolkit: assessed, not used

"REA" ("Reverse Engineer Anything") is a free reverse-engineering kit that was suggested for this work. On 14 October we assessed it by reading its public repository, documentation and npm record. Nothing was installed or run, and it is not installed on this computer.

| Question | Answer |
|---|---|
| What it is | The npm package `rea-agents` (version 6.4.0, MIT licence). It is both an MCP server (a plug-in an AI assistant can call) and a command-line tool, plus a skill file. It connects other analysis tools (the browser DevTools protocol, playwright, Babel, Ghidra and more) rather than being a new engine. One personal GitHub account maintains it. Releases are very fast: four versions between 9 and 11 October, with breaking changes. Many commits are co-authored by AI tools, so much of its code is AI-assisted. |
| What it would add for Kanvis | Little for screens, words and flows: its passive browser capture drops page text by default, and it cannot click. One real gain: it can show **which Kanvis code actually runs** when a person clicks something (V8 code coverage and lists of event listeners). It can also extract routes and endpoints from code more precisely. |
| What it would add for our own code | Nothing. Its own guidance says to skip it for a complete source repository. It treats TypeScript as plain text, and its documentation does not describe support for monorepos or Next.js. |
| Risks | Its setup writes into the global Claude configuration, so every start runs code fetched from npm. Its skill tells the AI to call tools without asking, which cuts across our "ask before acting" rules. The browser debugging port it needs gives deep control of the browser profile, so it must never touch the main Brave profile, which holds the Google, Supabase, Vercel and client sign-ins. Its captures can contain secrets and have no size cap. Supply chain: a single maintainer, native binaries, about 38 dependencies, and a star count (about 205,000 in six months) that should not be trusted. Its scripted mode would need session cookies. Recovering Kanvis's code goes beyond learning the experience, and REA's own disclaimer limits it to software you own or may examine. |
| Recommendation | **Skip it for now.** Our browser tools already give the screens, words and states in more detail. If one specific question ever needs "which code runs when I click X", do a one-off trial: the founder approves first. Run the pinned version (`npx -y rea-agents@6.4.0 …`) from the scratch folder, without its `setup` step, so nothing changes in `~/.claude.json` or the skills folders. Point it only at a throwaway Brave or Chrome profile started with its own `--user-data-dir` and `--remote-debugging-port=9222`. Use only the passive commands (list targets, inspect page, observe execution, analyse bundle). |

### 2.6 Evidence key

Every tag in square brackets in this document means the source below. Code files are at `https://www.kanvis.me/_next/static/chunks/<name>`. In our saved copies a "~" in a file name was stored as "T".

**Live pages and accounts**

| Tag | Source |
|---|---|
| [home] | https://www.kanvis.me/ |
| [recruiter] | https://www.kanvis.me/recruiter (hiring-team landing page; identical on 7 and 14 Oct) |
| [what-is] | https://www.kanvis.me/what-is-kanvis |
| [pricing-r] | https://www.kanvis.me/pricing/recruiters (and /pricing) |
| [whats-new] | https://www.kanvis.me/whats-new (changelog; cited by entry date, all 2026) |
| [waitlist] | https://www.kanvis.me/recruiter/waitlist |
| [demo] | https://www.kanvis.me/recruiter/demo, driven by hand on 7 and 14 Oct |
| [jobs] | https://www.kanvis.me/jobs |
| [job-pattern] | https://www.kanvis.me/jobs/a3zFVAbiulw4iUDuzTggww (branded company, open, 14 Oct) |
| [job-clickfortify] | https://www.kanvis.me/jobs/hJWPTuP7B_5vwSwKjnUm4g (unbranded company, 14 Oct) |
| [job-uplift] | https://www.kanvis.me/jobs/9X6Er-SXJpkr3FtscXlvtQ (branded; open on 7 Oct, closed on 14 Oct) |
| [job-codeable] | https://www.kanvis.me/jobs/xut_5ZNy1LoKJ2QwTPdqmg (unbranded, 7 Oct) |
| [careers] | https://www.kanvis.me/jobs/at/upliftai (a company careers page, 7 Oct) |
| [people] | https://www.kanvis.me/people and its city and skill pages |
| [profiles] | Two public candidate profiles at https://www.kanvis.me/<username> (owners not named) |
| [sitemap] [robots] [llms] | https://www.kanvis.me/sitemap.xml, /robots.txt, /llms.txt |
| [r-terms] [terms] [privacy] [dpa] | https://www.kanvis.me/legal/recruiter-terms, /legal/terms, /legal/privacy, /legal/dpa (read 7 Oct) |
| [cand] | The founder's candidate account, read-only (7 and 14 Oct): /candidate/workspace and its tools, Settings, the profile's owner view |
| [shells] | Anonymous requests for signed-in pages, which return an empty page frame (HTTP 200): /recruiter/dashboard, /recruiter/jobs, /recruiter/new-job, /candidate/workspace, /candidate/build (14 Oct); /recruiter/settings, /onboarding, /accept-invite, /jobs/[id], /jobs/[id]/decisions, /new-job/[id] (7 Oct) |
| [requests] | The 14 Oct request log: status codes and redirect targets |
| [sweep] | A keyword search across all 139 saved code files (7 and 14 Oct) |

**Code files first read on 7 October**

| Tag | File(s) | What it holds |
|---|---|---|
| [api-js] | 0.fhz3l5l-dh1.js | Shared API client: function names, error lines, API paths |
| [authapi-js] | 0q~lpev67y~-w.js | Sign-in API paths |
| [signin-js] | 0~o.ilr0bymp7.js | Sign-in dialog |
| [guards-js] | 069tg86y8n6-3.js | Route guards; company onboarding questions |
| [dashboard-js] | 139d3aj9--0z~.js, 0m_jdi1b5h-22.js | Hiring-team dashboard |
| [builder-js] | 0ef436qlv-522.js, 0phhdmrq87nep.js | Conversational Job Builder |
| [crew-js] | 0e1amni~ifc5i.js | "Hiring crew" panel |
| [jobhub-js] | 0t60nmilb7u78.js | Job hub: applicants, analytics, share, details |
| [appdetail-js] | 0ixuyr.7zf1l9.js | Application detail: drawer tabs, notes, history, stage dialog |
| [decisions-js] | 0m2ro0w7m.w69.js | Decision board |
| [rubric-js] | 03g8bicf3y0hg.js | Scoring rubric editor |
| [reviewer-js] | 0qwqbfaov.5gy.js | "Ask about your applicants" chat |
| [settings-js] | 0ste.a~-y_9fw.js | Hiring-team settings |
| [apply-js] | 03g-cdf8~z33_.js | Apply dialog; interview preparation screen |
| [jobpage-js] | 0pslqbahd9sm2.js | Public job page, apply routes, status |
| [answers-js] | 10cvqvyf.ica2.js | Employer question widgets; candidate progress |
| [board-js] | 07xwqqg_txf7g.js | Public job board filters and profile gate |
| [upload-js] | 04xbj03qynh90.js | CV upload and candidate onboarding steps |
| [portfolio-js] | 0cyqxu92je7qb.js | Public profile page |
| [twin-js] | 0d20ico6lsdje.js | Twin chat box on profiles |
| [waitlist-js] | 0zt1klac535ef.js | Waitlist with a candidate attached |
| [reserved-js] | 0c7--uh95mzjc.js | Reserved usernames |
| [candroutes-js] | 0tj9ba5twfp4k.js, 14s1dfza80a~j.js | Candidate routes; shared start-up code (analytics set-up) |
| [demo-js] | 0ivk~x0gxey07.js | The demo's script and data |

**Code files first read on 14 October**

| Tag | File(s) | What it holds |
|---|---|---|
| [sidebar-js] | 0twgdvu7h-c3m.js | Workspace sidebar; shared AI error lines |
| [ws-js] | 100ouyouh7y8u.js, 16or-hl3j2m-q.js, 0h1va~ox19lnf.js | Workspace guard, loading and error screens |
| [stages-js] | 027w5-~_xkxxo.js | Pipeline stage labels |
| [jobslist-js] | 0os0_~rv3f8yk.js | Jobs list; LinkedIn announcement composer |
| [newjob-js] | 029jqrjuoufvi.js, 0~1jo.ie3gkf0.js | New-job quick start; hiring-crew text; error lines |
| [icons-js] | 0ab8k84cjr8u3.js | Icon list with plain-English meanings |
| [onb-js] | 0sh3n9n4sp.3v.js, 0ivj~kzv7qtq_.js | Company onboarding |
| [invite-js] | 0x4i.zvro25.8.js | Accept a teammate invite |
| [cbuild-js] | 04clkv0p_359a.js, 04ekor9x3kn7u.js, 17qhh.67~mfsq.js | Candidate profile builder; apply-from-build banner |
| [cws-js] | 0ztoj-yd_2yn0.js | Candidate workspace, tools and settings |
| [jdfit-js] | 08tkbi5cdu~-v.js | Job-fit analysis |
| [capp-js] | 0km843nb_q2hd.js | Candidate application page and statuses |

---

## 3. What changed between 7 and 14 October 2026

**In plain words.** Kanvis did not change its product. Its data changed a little. Our own earlier notes had a few mistakes, now corrected. Several open questions were closed by reading code we had not downloaded before, and by clicking the demo more carefully.

### 3.1 The build is unchanged

| Fact | 7 Oct | 14 Oct | Label | Evidence |
|---|---|---|---|---|
| Deployment id in every asset address | dpl_CXNGXfzLmQpDVX7Lp52pcab9uy9u | same | OBSERVED | every page |
| Code file names (made from the files' contents) | as recorded | the same names, referenced by every page | OBSERVED | [shells] |
| Code files byte-for-byte identical | n/a | 0.fhz3l5l-dh1.js (API client), 0t60nmilb7u78.js (job hub), 14s1dfza80a~j.js (fingerprints match) | OBSERVED | [requests] |
| Pages byte-for-byte identical | n/a | /recruiter, /what-is-kanvis, /recruiter/demo, /pricing, /pricing/recruiters, /whats-new, robots.txt, llms.txt, the /recruiter/dashboard frame | OBSERVED | page fingerprints |
| Changelog's last entry | 28 Sep 2026 (Job Builder quick start) | same | OBSERVED | [whats-new] |
| Technology | Next.js App Router built with Turbopack, hosted on Vercel; React 19 preview; PostHog analytics through /ingest | same (identical files) | INFERRED (read in the code on 7 Oct; the Vercel deployment id is OBSERVED) | [candroutes-js] |
| Stack named in the legal text | Google Cloud (Cloud Run, Cloud SQL, us-central1), Firebase sign-in, Gemini as the only AI provider, LlamaParse for documents, Vercel, Resend for email, PostHog | not re-read | INFERRED | [dpa] Annex 3; [privacy] §6D |

### 3.2 What changed: data only

| Change | Detail | Label | Evidence |
|---|---|---|---|
| Job board roster | Still 17 roles from 12 companies. Gone: two Uplift AI roles (Founding Design Engineer; BD Executive, AI Voice Agents). New: Pattern "Full-Stack Developer (Django + React/React Native)", posted 14 Oct, and ClickFortify "Sales Developer Representative", posted "4 days ago". | OBSERVED | [jobs]; [cand] (company counts in the filter panel) |
| A job closed by its deadline | Uplift AI's "Founding Engineer (Full-Stack + ML)" said "Apply by Sunday" on 7 Oct. On 14 Oct its page reads "Applications closed" and "This role is no longer hiring", with "Browse open roles". Its machine-readable end date is 2026-10-12 06:59:59 UTC: the end of Sunday 11 Oct in the company's US Pacific time zone. | OBSERVED | [job-uplift] |
| Why it closed | Most likely it closed itself at its deadline, as the changelog describes. | INFERRED | [whats-new] 26 Aug, 5 Sep |
| The closed job still looks open elsewhere | It is still on /jobs and in other jobs' "More roles on Kanvis" lists, with nothing marking it closed. | OBSERVED | [jobs]; [job-clickfortify] |
| Sitemap | 454 → 492 addresses: 38 new public profiles, 2 new job pages, 2 removed, 17 job pages in all. No new kinds of page. | OBSERVED | [sitemap] |
| Logo strip | "Teams already hiring on Kanvis" adds ClickFortify and Pattern (15 logos, up from 13) on the home and waitlist pages. | OBSERVED | [home]; [waitlist] |
| Featured profiles | The home page and "more people" rails rotated. | OBSERVED | [home]; [profiles] |

### 3.3 Corrections to the 7 October notes

| # | Topic | The 7 Oct notes said | What we now know | Label | Evidence |
|---|---|---|---|---|---|
| 1 | How a new job starts | The demo's chat box ("What are you hiring for?") was described as the way a role starts. | That prompt exists only in the demo's code. The real /recruiter/new-job is a 10-step tap "quick start" that can be pre-filled from a dropped job description, followed by "Write the job post". The chat-style Job Builder comes after, at /recruiter/new-job/[id]. The 28 Sep changelog entry agrees. | INFERRED | [newjob-js]; [demo-js]; [whats-new] 28 Sep |
| 2 | "Why this matters" on the demo's question card | One note called it collapsible; the code reading said it is never shown. | In the demo it is a plain line of text with an arrow: not a button, nothing expands, the explanation never appears. The real builder is UNKNOWN. | OBSERVED (demo) | [demo] |
| 3 | Ask AI | The assistant could "move anyone". | In the demo every answer is a pre-written example labelled "EXAMPLE". Typed questions get the closest pre-written answer, and "move Ben to the shortlist" moves nobody. That the real assistant can move people (after asking) is INFERRED from code. | OBSERVED (demo); INFERRED (product) | [demo]; [reviewer-js] |
| 4 | Evidence references on profiles | "chat_source null throughout" | Some entries do carry a numeric chat reference (6 of 36 and 18 of 48 on the two profiles checked, with the same values on 7 Oct). None is shown as a link, not even to the profile's owner. | OBSERVED | [profiles]; [cand] |
| 5 | /recruiter/jobs/new | A redirect, target not captured | Redirects (307) to /recruiter/new-job. | OBSERVED | [requests] |
| 6 | LinkedIn composer tones | "Warm, celebratory / Crisp, factual / Light, human" | Those are sub-labels. The tone names are Proud, Direct and Playful. | INFERRED | [jobslist-js] |
| 7 | "No research pass signed in" | Stated in the 7 Oct catalogue | Wrong: a signed-in candidate session took place on 7 Oct in the founder's candidate account. Its findings are now merged into section 5. | OBSERVED-EARLIER | [cand] |
| 8 | Reason for a stage move | "Every move asks for a reason" | The product's reason box is optional (the code falls back when it is empty). The demo asks for nothing. | INFERRED (product); OBSERVED (demo) | [appdetail-js]; [demo] |
| 9 | Candidates' monthly application cap | "Fallback value 50, inferred" | Shown on screen: "50 of 50 applications left this month", on 7 and 14 Oct. | OBSERVED | [cand] |
| 10 | Board chips for Ben and Lena | Not recorded | Both carry "Confident". Newly recorded, not a change. | OBSERVED (demo) | [demo] |
| 11 | A candidate's personal match reasons | INFERRED from code | "Why this is on your board" seen in the candidate's job panel. | OBSERVED | [cand] |
| 12 | A candidate opening a hiring-team page | Code reading: sent to the home page "/" | A signed-in candidate opening /recruiter/dashboard ends up on /candidate/workspace (possibly by way of "/"). | OBSERVED | [cand]; [guards-js] |
| 13 | A hidden search on /people | Open question | No search box and no form; only city and skill links. | OBSERVED | [people] |
| 14 | Pay period and benefits on job pages | Not seen on screen | A "/ month" pay period and a "What they offer" benefits block appear on a branded company's page. | OBSERVED | [job-pattern] |
| 15 | Résumé styles | Code names three templates (Classic Professional, Modern Compact, and one with the name left-aligned and projects first) | The screen offers four styles: Modern Compact, Executive, Tech Builder and Academic. The screen wins; the code list may be older or internal. | OBSERVED (screen); INFERRED (code) | [cand]; [cws-js] |
| 16 | Outreach tones | Code: "Friendly, personable", "Concise, professional", "Traditional, careful" | Screen: Warm, Direct and Formal. The code strings are probably their descriptions. | OBSERVED (screen); INFERRED (code) | [cand]; [cws-js] |
| 17 | Job board heading | "Jobs in Pakistan, applied to by talking" | The visible heading on 14 Oct is "Discover Jobs made for You! Apply in seconds." The build is the same, so the first is most likely the page title and the second the heading. | OBSERVED | [jobs] |

### 3.4 Open items closed on 14 October

| Item | Now known | Label | Evidence |
|---|---|---|---|
| What the real "New job" looks like | The 10-step quick start (section 4.3) | INFERRED | [newjob-js] |
| The hiring-team sidebar | Dashboard, Jobs, New job, Workspace settings, Sign out | INFERRED | [sidebar-js] |
| The jobs list at /recruiter/jobs | Filters, sorting, row badges and empty states (section 4.12) | INFERRED | [jobslist-js]; [shells] |
| Company onboarding: is the website pre-fill visible? | Yes, each answer is labelled "From you" or "Website", and it can be skipped (section 4.2) | INFERRED | [onb-js] |
| Accepting a teammate invite | Link states, locked email, 6-digit code (section 4.1) | INFERRED | [invite-js] |
| What the demo really lets you do | Only the Applicants tab works; only the Overview and Interview drawer tabs work, and there is no Résumé tab; board cards, next-action tags, Regenerate and the next-step arrows do nothing; there is no drag-and-drop; only Lena can be held back; only "Move to Hired" works, works even before screening, and cannot be undone; Review & apply locks after use; chapter 05 resets to the script. | OBSERVED (demo) | [demo] |
| Do unlisted profiles leave search? | Yes: absent from the sitemap, /people and the Islamabad city page (first page checked) | OBSERVED | [cand]; [sitemap]; [people] |
| Does the profile owner see evidence links? | No: none anywhere, even in the owner's view | OBSERVED | [cand] |
| Interview scheduling, approvals, integrations, billing screens | None found in any of the 139 code files | INFERRED (absence) | [sweep] |
| Still open | What happens after the waitlist; the real builder's "Why this matters"; the real board, rubric, drawer tabs, email composer and Twin answers; real interview length; what makes a candidate see "Shortlisted"; how plan limits are enforced | UNKNOWN | section 9 |

---

## 4. Recruiter journeys

Kanvis calls every hiring-team seat a "recruiter". In our words that is the owner or any teammate (section 1.5). Each journey below has:

- **In plain words**: what happens, for a non-technical reader;
- **Sequence**: the steps in order, each with its label and evidence;
- **Detail**: a table in the brief's order: entry point; person and permissions; screens, dialogs, drawers and menus; inputs and checks; loading, error and success states; what information is collected and when; who decides; what changes afterwards; edge cases and failures;
- **Touches our decisions**, where relevant: a reference only, never a new question.

Where the demo and the real product differ, both are given, and the demo is marked "(demo)".

### 4.1 Getting access: waitlist and invites

**In plain words.** A company cannot sign itself up. It asks to join a waitlist, and Kanvis staff set it up. After that, an owner invites teammates by email.

**Sequence: a new company**

1. A visitor reads /recruiter or /pricing/recruiters. Every button goes to /recruiter/waitlist: "Get early access", every plan and role-pass button (these add ?plan=<plan>), and "Put one role through it". The other route in is "Book 30 minutes", a call with the Kanvis founder on cal.com. *(OBSERVED; [recruiter] [pricing-r] [demo])*
2. The waitlist page says early access is limited. The form asks for a plan (optional: Free, Pro, Team, Scale, Enterprise, Role pass, Not sure yet), "Your name", "Company name", "Contact email" and "Phone" (optional), then "Request early access". *(OBSERVED; [waitlist])*
3. After sending, the page promises to say when "your spot opens up". What follows (an email, a call, how long it takes) was never seen. *(UNKNOWN)*
4. Kanvis creates the company and its first Owner, and offers to set up the first role with you. *(INFERRED; [r-terms] §2 [recruiter])*
5. Sign-in is with Google or a 6-digit code sent by email. There are no passwords. A draft started before sign-in can be kept afterwards ("adopt-draft"). *(INFERRED; [signin-js] [authapi-js] [privacy] §2A)*
6. On first sign-in, an owner whose company is not set up is sent to company onboarding (4.2). *(INFERRED; [guards-js])*

**Sequence: a teammate**

1. An owner opens Settings, Team, "Invite teammate" and enters a full name, a work email and the role (Owner or Member). *(INFERRED; [settings-js])*
2. The teammate opens the emailed link to /recruiter/accept-invite. The invited email cannot be changed ("Why is this email locked?"). Sign-in is by 6-digit code, and accepting points to the recruiter terms, the data processing agreement, the terms and the privacy policy. *(INFERRED; [invite-js])*
3. Progress lines show "Getting your account ready", "Signing you in" and "Loading workspace", then the workspace opens. *(INFERRED; [invite-js])*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | /recruiter, /pricing/recruiters and the demo's "Get Started". A public candidate profile's "Hire me" also goes to the waitlist, with that candidate attached ("This profile is filed with your request."). | OBSERVED; INFERRED (the quoted line, from code) | [recruiter] [pricing-r] [demo] [profiles]; [waitlist-js] |
| Person and permissions | Anyone may ask; Kanvis staff decide who gets in. Invitations are single-use, time-limited and tied to one email. | INFERRED | [r-terms] §2 |
| Person and permissions | One sign-in is either a candidate or a hiring-team seat, never both: the founder's candidate account opening /recruiter/dashboard was sent to the candidate workspace. | OBSERVED (the redirect); INFERRED (the rule) | [cand]; [r-terms] §2 |
| Screens, dialogs, menus | The waitlist page is a single form. Accept-invite is a full-screen page outside the workspace frame. No sign-up page exists anywhere. | OBSERVED (waitlist); INFERRED (invite, absence) | [waitlist]; [invite-js]; [sweep] |
| Inputs and checks | Waitlist: name, company and email; phone and plan optional. Invite: full name, work email, role. | OBSERVED (waitlist); INFERRED (invite) | [waitlist]; [settings-js] |
| Loading, error, success | Invite link states: already joined, expired, withdrawn, incomplete link, not found, network failure ("Your invite is most likely fine, so try again."). A way out to the waitlist: "Request recruiter access". | INFERRED | [invite-js] |
| Information collected, and when | At the waitlist: name, company, email, and optionally phone and plan. Company details come later, in onboarding. | OBSERVED | [waitlist] |
| Who decides | external: Kanvis staff approve and create the company. user: the owner chooses whom to invite, and as what. code: locked email, link expiry, and the last owner cannot be removed. | INFERRED | [r-terms] §2; [invite-js]; [settings-js] |
| What changes afterwards | A company with one owner; seats counted against the plan (Free 1, Pro 1, Team 3 then $39 each, Scale the whole team). | INFERRED (seats on pricing OBSERVED) | [pricing-r] |
| Edge cases and failures | A candidate account cannot be reused for hiring. A suspended company sees "Your workspace is suspended" (usually a billing or account matter), "Your data is safe." and "Contact support", with settings read-only. | INFERRED | [ws-js]; [guards-js] |
| Edge cases and failures | The pricing page promises a once-only 30-day Team trial with no card, but no code file mentions a trial. | OBSERVED (promise); INFERRED (absence) | [pricing-r]; [sweep] |

*Touches our decisions:* B7 (open sign-up, with public pages waiting for a one-time ITS check) and Q2 (Google or Microsoft only, no email codes). Kanvis is closed sign-up and uses email codes.

### 4.2 Company onboarding

**In plain words.** The first owner gives the company website, and optionally a company document. Kanvis reads them, fills in what it can and labels where each answer came from. The owner checks the answers, fills in the rest, and finishes now or later.

**Sequence**

1. The owner lands on /recruiter/onboarding, a full-screen page. Until it is done, every page except Settings sends the owner back here. Teammates who are not owners are sent to the dashboard. *(INFERRED; [guards-js])*
2. The owner gives the company website and, optionally, a pitch deck or company overview (PDF, Word or text). The buttons are "Read my website", "Read my documents" and "I'll answer myself". The page promises that every filled-in answer is yours to check and change. *(INFERRED; [onb-js])*
3. Result: "We filled these in", each answer labelled "From you" or "Website", a count ("Filled in N of M answers") and the list of questions still open. *(INFERRED; [onb-js])*
4. If several offices are found, it asks "Which office do you hire from?" and warns that new jobs will use that location. *(INFERRED; [onb-js])*
5. The remaining questions come one at a time. Fixed answers (stage, team size, work setup) are single taps, with a way to type instead. A progress button lists every question and the answers so far. *(INFERRED; [whats-new] 25 Aug)*
6. The owner presses "Looks right, finish setup", or "Finish later" (the rest can be filled in from Settings). *(INFERRED; [onb-js])*
7. Until setup is finished, the dashboard shows "Finish setting up <company>. Your job posts are written from it." with a "Finish setup" link. *(INFERRED; [dashboard-js])*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Forced on the owner's first sign-in; the dashboard banner; Settings later | INFERRED | [guards-js]; [dashboard-js] |
| Person and permissions | Owners only | INFERRED | [guards-js] |
| Screens, dialogs, menus | Full-screen page: reading step, result list with source labels, office picker, one question per screen, progress panel | INFERRED | [onb-js]; [whats-new] 25 Aug |
| Inputs and checks | What you do; Industry (about 75 choices); Type of organisation (established business, non-profit, public sector, listed company, startup by funding stage); Team size; Location; Work mode (Remote, Hybrid, Onsite); How you hire; Mission; How you work; What you offer. A core set seems required, with a minimum you can skip down to. | INFERRED | [guards-js] |
| Loading, error, success | Every reading error falls back to "answer the questions yourself". | INFERRED | [onb-js] |
| Information collected, and when | Company facts at onboarding. Kanvis uses them whenever it writes a job post or interview questions. It also builds a "style profile" from builder chats and published posts, so that later posts sound like the company. | INFERRED | [r-terms] §2; [privacy] §2A |
| Who decides | AI: reads the website or document and proposes answers. user: the owner confirms or edits. code: forces the route until setup is done. | INFERRED | [onb-js]; [guards-js] |
| What changes afterwards | The company is marked set up; its default work mode pre-fills new jobs; company context feeds every post. | INFERRED | [settings-js] |
| Edge cases and failures | Several offices; an unreadable site or file; "Finish later"; a teammate cannot open the page. | INFERRED | [onb-js]; [guards-js] |

*Touches our decisions:* Q3 (a short company form plus time zone; the rest collected later). Website pre-fill is already in our backlog.

### 4.3 Job builder and publishing

**In plain words.** In the real product, a recruiter taps through ten short screens of facts, or drops in an existing job description to pre-fill them. Pressing "Write the job post" produces the post; the recruiter then refines it by chatting with the AI beside a live preview. Publishing opens the job at once: there is no approval step. The demo shows a chattier start than the real product.

**Sequence: the real product** *(INFERRED from code unless marked)*

1. The recruiter opens "New job": from the sidebar, with Shift+N on the jobs list, from the dashboard nudge "Post your first job.", or at /recruiter/jobs/new, which redirects to /recruiter/new-job *(redirect OBSERVED; [requests])*. The page is full screen, outside the workspace frame *(OBSERVED; [shells])*. *([sidebar-js] [jobslist-js] [dashboard-js])*
2. **Step 1 of 10, Job title.** Optionally the recruiter drops a job description ("PDF, Word or text up to 5 MB"). Kanvis reads it ("Reading your job description…", then "Filling in the answers from it") and marks the steps it filled with "Filled in from your job description." "Stop reading and answer myself" stops the reading. *([newjob-js])*
3. **Steps 2 to 6.** *([newjob-js])*
   - Employment type: Full time, Part time, Contract, Internship, Freelance.
   - Location: Remote, Hybrid or Onsite. Candidates from "Anywhere" or "Only in" listed countries. An office address with Google Maps suggestions.
   - Minimum experience: No minimum, 1+, 2+, 3+, 5+ or 8+ years. Only when a minimum is set: "Anyone with less than N years?", answered "Still consider them" or "Rule them out". A senior job title prompts "Senior roles usually ask for 3+ years."
   - Salary: "Will the post show the pay?" Either a range per month, year or hour, or keep it off the post. The currency is guessed from the location (11 currencies).
   - Application deadline: a date within a year, or "No deadline".
4. **Step 7, Must-have skills.** The AI suggests skills from the answers so far. "Tick at least one. Every applicant is checked against these." The number of must-haves is capped, and the rest become nice-to-haves. "Choose them later" is allowed. *([newjob-js])*
5. **Step 8, Dealbreakers** ("What rules someone out?", or "None of these"). **Step 9, Screening questions** ("Every applicant answers these."): suggested questions can be unticked, and "Add a question" adds one. *([newjob-js])*
6. **Step 10, Review.** One row per step, each with Edit, then "Write the job post" ("Writing the job post…"). *([newjob-js])*
7. **The conversational Job Builder** opens at /recruiter/new-job/[id], full screen. *([builder-js]; [whats-new] 23 Sep)*
   - One side holds the chat with the "hiring crew"; the other side holds "Your job post".
   - Status lines read like "Question N of M" and "Waiting for your answer".
   - Questions come with chip answers and a "why" note.
   - The post has three sections (The role; What you're looking for; Screening questions), each with an "Ask the agent" button.
   - Each AI reply shows expandable steps, a diff of what changed and a link that jumps to that part of the post. Editing one part does not rewrite the rest.
8. **Structured fields sit beside the chat.** *([builder-js] [recruiter])*
   - Basics: employment type, work mode, office, pay from and to (11 currencies, per year, month or hour), an apply-by date, and years of experience with a "rule" switch.
   - Requirement buckets: Must have, Nice to have, Rules someone out, In your own words. Their scoring effect is shown as "Rules out", "Counts in their favour" or "Counts against them".
   - Screening questions: typed Written answer, Pick one, Pick several or A number, each with a required flag and a private note.
   - A "Private criteria" field that candidates never see.
   - A preview of how applicants will be scored and how much each requirement counts.
9. A scoring rubric is drafted, and a second AI reviewer checks it for traps (section 4.6). *([whats-new] 28 Jun)*
10. "Save and exit" keeps a draft. Publish opens the job for applications, and the AI interviewer starts talking to everyone who applies. *([builder-js])*

**Sequence: the demo film** *(OBSERVED (demo), chapters 01 and 02, which cannot be clicked)*

1. "NEW JOB · ACME PAY" asks "What are you hiring for?". It shows a chat box ("Describe the role, or paste a JD you already have."), "Attach documents", a microphone and four role chips. None of these are real buttons in the film. Maya types one line: a senior backend engineer for payments, 5+ years of Python, remote UK.
2. The fake address changes to an edit page and the left rail shrinks to icons. The header shows "EDITING", "Untitled job", a Draft chip and a dimmed Publish button ("Add a title and description first.").
3. The agent asks three questions on one card that replaces the chat box. The card shows "PICK ONE" or "PICK ANY THAT APPLY", a "1 OF 3" pager, option pills, a static "Why this matters" line, and "Next" ("Send" on the last question).
   - Q1: the first thing the person would own.
   - Q2: which skills are true must-haves. Ticked ones become hard requirements; the rest become nice-to-haves.
   - Q3: whether to add three screening questions, asked inside the interview ("Add it" or "Skip").
4. The answers come back as one summary bubble, and progress ticks run ("Writing the description…" and so on). The preview on the right fills in four passes:
   - the title;
   - "Remote · Full-time · £95,000 – £120,000 · Open-ended" (Maya never gave a pay range, so the agent proposed one);
   - What you'll do, What we're looking for, and Nice to have (the agent added "Worked somewhere regulated" on its own);
   - three required screening questions.
5. A chat card offers "Preview listing" and "Publish listing" (neither works). Publish opens a modal, "Your job is live.", whose "Where it went" section lists Public listing and LinkedIn ("Announced to your network"). Both rows are plain text. Then "Go to your job →".

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Sidebar "New job" (N hint in the demo); "New job (Shift+N)" on the jobs list; dashboard nudge; /recruiter/jobs/new redirects to /recruiter/new-job | INFERRED; redirect OBSERVED | [sidebar-js] [jobslist-js] [dashboard-js]; [requests] |
| Person and permissions | Any seat holder appears able to start a job. Whether a Member can publish is not stated. There is no approval step: the word "approv" appears in no code file. | INFERRED; UNKNOWN (Member publish) | [sweep] |
| Screens, dialogs, menus | Full-screen quick start, one step per screen, with a spoken progress line for screen readers ("Step N of 10, <label>"). Full-screen builder with a split view ("Show/Hide the job" on phones). A "Discard this job?" confirmation. The publish modal (demo). | INFERRED; OBSERVED (demo modal) | [newjob-js] [builder-js]; [demo] |
| Inputs and checks | At least one must-have; a deadline within a year; a job-description file of 5 MB or less (PDF, Word or text); a pay range with its period. Enter moves to the next step. | INFERRED | [newjob-js] |
| Loading, error, success | Reading progress lines. Errors for a file that is too big, empty, unreadable or too slow, each falling back to typing into the Job title box. Shared AI error lines such as "Too many requests in a short time — pause for a moment and retry." | INFERRED | [newjob-js]; [sidebar-js] |
| Loading, error, success | Demo progress ticks and "Your job is live." | OBSERVED (demo) | [demo] |
| Information collected, and when | Facts first (quick start), wording second (builder). Company context comes from onboarding and from the Company library, documents the AI reads for every job. Attached documents stay with the job. | INFERRED | [newjob-js] [builder-js] [settings-js] |
| Who decides | user: facts, ticks, edits and Publish. code: step order, currency guess, the "Rule them out" follow-up, the draft saved in the browser. AI: suggested skills and screening questions, the post text, the rubric draft, and (demo) a proposed pay range. external: Google Maps address suggestions. | INFERRED; OBSERVED (demo pay) | [newjob-js] [builder-js]; [demo] |
| What changes afterwards | A draft job appears under Drafts ("Draft · Nd old"), with a dashboard nudge ("Your draft … is waiting to go live"). On Publish the public page goes live at once, appears on /jobs and in the sitemap with job-posting data, and the interviewer starts. Edits to a live job show quickly. Changing screening questions on a live job warns "Candidates are answering these now." | INFERRED | [jobslist-js] [dashboard-js] [builder-js]; [whats-new] 25 Aug |
| Edge cases and failures | Leaving midway: the quick-start draft is kept in this browser's storage only (one fixed key), so it would not follow the recruiter to another device. "Discard this job?" clears it. An unreadable job description falls back to typing. | INFERRED | [newjob-js] |
| Edge cases and failures | The demo's "Why this matters" never opens; its Edit toggle, "Preview listing", "Publish listing", Attach, microphone and chips do nothing. | OBSERVED (demo) | [demo] |
| Who the "hiring crew" are | Six named AI helpers ("Kips"): Writer, Reviewer, Scorer, Interviewer, Promoter and Analyst. Each shows a status: Ready when you are, Thinking, Working, Needs you, Done or Stuck. Each has one job and they pass work between them, so the recruiter only answers what needs a person. | INFERRED | [crew-js]; [newjob-js] |

*Touches our decisions:* Q4 and Q5 (our full-screen drafting space at /roles/new), Q8 (first draft after one round of up to three tap-to-answer questions), Q9 (we always show pay; Kanvis lets the recruiter hide it), Q10 (we ask for approval on some live edits; Kanvis has no approvals).

### 4.4 Sharing, distribution and the public job page

**In plain words.** Publishing puts the job on its own public page, on Kanvis's job board and in Google's job results. The recruiter can then announce it on LinkedIn by copying an AI-drafted post, or share tracked links. As far as we can tell, Kanvis never posts anywhere by itself.

**Sequence**

1. On Publish, the public page /jobs/<22-character id> goes live. *(live pages OBSERVED; timing INFERRED from [whats-new] 25 Aug)*
2. The job appears in several places. *(OBSERVED; [jobs] [careers] [job-clickfortify] [job-pattern])*
   - on /jobs;
   - on the company's careers page, /jobs/at/<company>;
   - in "More roles on Kanvis" on other companies' unbranded pages;
   - in Google job results, through job-posting data (end date = deadline, direct apply, pay with its period, skills).
3. **LinkedIn.** *(INFERRED; [jobslist-js] [dashboard-js]; [whats-new] 11 Jul)*
   - Where: the "Post to LinkedIn" icon on a jobs-list row, the dashboard's "Your roles", the Share tab or the Details tab.
   - The composer drafts an announcement in a chosen tone: Proud ("Warm, celebratory"), Direct ("Crisp, factual") or Playful ("Light, human").
   - It shows a character meter (800 to 2,500 recommended, 3,000 at most), hashtags and a preview styled like a LinkedIn feed.
   - "Open LinkedIn — post ready" copies the text and opens LinkedIn; the recruiter posts it.
   - If drafting fails, the recruiter writes the announcement in the same box.
   - Days later the job reports how many applicants came from that post.
4. **Other sharing.** Share buttons (LinkedIn, WhatsApp, Facebook, X, email) appear in the empty applicant list. Named tracked links live in the Share tab (section 4.11). *(INFERRED; [jobhub-js])*

**What the public job page shows**

| Part | Finding | Label | Evidence |
|---|---|---|---|
| Header | Logo, company, title, location and work mode (with a map link when an address is given), type, pay ("PKR 150,000 – 300,000 / month"; "Up to …" when only a maximum is set; "… +" when only a minimum is set; hidden when unset), a deadline line ("Apply by Sunday"), "Posted today" | OBSERVED; OBSERVED-EARLIER (the "Up to" and "+" pay forms, seen on other job pages on 7 Oct) | [job-pattern] [job-clickfortify] |
| Body | "About the role" (the company's own text), then "End of description", then "What they're looking for" (Must have and Nice to have; left out when empty), then "Skills named in this posting" chips | OBSERVED | [job-pattern] |
| Company block | Branded companies (custom page design is Team plan and up): colour banner, tagline, website, About (location, size, website) and "What they offer" benefits. Unbranded companies: a generated colour band, "All open roles" and "More roles on Kanvis". | OBSERVED | [job-pattern] [job-clickfortify]; [pricing-r] |
| Apply card | "Apply for this role" and four promises: a short conversational interview; start from your résumé, no cover letter; about 5 to 10 minutes; the hiring team decides, not the AI. Rows: Location, Type, Compensation, Applications, Posted. | OBSERVED | [job-pattern] |
| Phone layout | A fixed "Apply for this role" bar at the bottom | INFERRED | [jobpage-js] |
| Screening questions | Never listed on a real page: none of 10 pages on 7 Oct, none of 3 on 14 Oct. The demo's preview does list them, under "You'll be asked during the application". | OBSERVED | [job-pattern]; [demo] |
| Closed or paused | Closed: "Applications closed", "This role is no longer hiring", "Browse open roles". The page stays online and visible to search engines. | OBSERVED | [job-uplift] |
| Closed or paused | Paused: "Applications are on hold". | INFERRED | [jobpage-js] |

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Publish; then the LinkedIn composer, the Share tab, the dashboard and the jobs list | INFERRED | [builder-js] [jobslist-js] [dashboard-js] [jobhub-js] |
| Person and permissions | Any seat holder. Tracked links and custom page design are Team plan and up. | INFERRED (plans OBSERVED) | [pricing-r] |
| Inputs and checks | Tracked-link tags in the address: ?src= or ?r= (1 to 32 characters), and ?source_invite= for invited people | INFERRED | [apply-js] |
| Who decides | user: posts to LinkedIn and shares. AI: drafts the announcement. code: builds the page and its search-engine data. external: LinkedIn and Google. | INFERRED | [jobslist-js]; [job-pattern] |
| What changes afterwards | Visits and applicants are counted per source (section 4.11). | INFERRED | [jobhub-js] |
| Edge cases and failures | A closed job still looks open on the board and in "More roles on Kanvis". | OBSERVED | [jobs] |
| Edge cases and failures | A removed tracked link keeps working. Employers may pay to move their job up, but only among jobs a candidate already matches. | INFERRED | [jobhub-js]; [privacy] §5; [terms] §2A |
| Edge cases and failures | The demo says LinkedIn was "Announced to your network"; the code copies the text and opens LinkedIn. Whether anything ever posts without the recruiter is not settled. | UNKNOWN | [demo]; [jobslist-js] |

*Touches our decisions:* Q11 (channels: careers page and Google always; LinkedIn and Indeed when the plan names them) and Q12 (closing date: Kanvis also closes at the end of the day and lets people part-way through finish). A LinkedIn announcement template is in our backlog.

### 4.5 Applicants list and candidate drawer

**In plain words.** Each job has a hub page with tabs. The Applicants tab lists everyone with a score, a stage and an AI verdict. Clicking a person opens a panel from the right (a "drawer") with the AI's view, the score breakdown, the interview transcript and more, without leaving the list.

**Sequence: the demo** *(OBSERVED (demo); [demo])*

1. The job hub shows "JOB · ACME PAY", the title, a Live chip and "6 applicants · closes in 3w". Tabs: Applicants 6, Compare, Rubric, Analytics, Share, Details. Only Applicants works.
2. A strip reads "Let the AI screen your 6 applicants", with a "Screen the pool" button that opens the decision board (4.7).
3. Stage filter pills carry counts: All 6, New 6, Longlisted 0, Shortlisted 0, 1st Interview 0, Hired 0, Disqualified 0. An empty stage says "No applicants in this stage yet."
4. Each row shows:
   - initials and name, and "Applied today";
   - a stage pill (tooltip "Change stage");
   - a score badge (tooltip "Match score 91 / 100"; 91, 88, 84 and 71 green, 58 amber, 44 grey; the cut-offs of 70 and 55 come from the demo's code);
   - an arrow.

   Only Priya's row opens.
5. The drawer slides in over the dimmed list, and Esc closes it.
   - Header: the name, "Applied today · Senior Backend Engineer", an "Email" button (tooltip only; it does nothing), the stage pill ("In your pipeline: New — click to move") and Close.
   - Tabs: Overview, Compare, Interview, Profile, Notes and History. Only Overview and Interview work, and there is no Résumé tab.
6. **Overview tab.**
   - "THE AI'S READ" with "AI is confident", the verdict "Shortlist" and a one-line headline.
   - A six-sided radar chart.
   - "AGAINST YOUR RUBRIC 91/100" with the weights (25, 15, 15, 25, 12 and 8 per cent).
   - "WHAT IT COST HER": per requirement, the share met and the points lost (82% −4.1, 88% −4.0, 96% −0.6, 98% −0.3), then "2 more requirements at full marks."
   - Tooltips say a failed must-have "sinks them in the list", and "Cost 4.1 points of the rubric".
   - The line "You shortlisted this candidate — the AI agreed." shows even while she is still New: a slip in the demo.
7. **Interview tab.** "SCREENING ANSWERS" shows one question, a "text" type chip and her answer. "THE CONVERSATION" shows two AI follow-ups built on her own words, and her replies.

**What the real product adds** *(INFERRED from 7 Oct code)*

| Part | Finding | Evidence |
|---|---|---|
| List controls | Search ("Search name, email, notes…"); score-band filter; source filter (applied themselves, or imported CVs); sort by score, most recent or stage | [jobhub-js] |
| AI verdict labels | Needs your eye, Clear fit, Worth a look, Likely no, Not yet ranked, Verify eligibility | [jobhub-js] [demo-js] |
| Flags | "Duplicate?" (same email on this job), "Too close to call", "Scored with reduced analysis" | [jobhub-js] |
| Status pills | Scoring…, Interviewing, New, Résumé only (applied with a CV before finishing a profile; not scored until they do), Needs review ("Scored — your call."), Shortlisted, Rejected, Withdrawn | [dashboard-js] |
| Bulk actions | Select rows, then "Move to…" a stage, or send a bulk email (4.10) | [jobhub-js] |
| Tune ranking | A drawer where dragging rubric weights re-ranks the list live | [jobhub-js] |
| Drawer movement | The address carries ?applicant=<id>; Shift+K and Shift+J for previous and next; "N of M"; "Open full screen" (/recruiter/jobs/[id]/applications/[appId]) | [jobhub-js] |
| Drawer tabs | Overview, Compare, Interview, Profile, Résumé, Notes, History | [appdetail-js] |
| Overview (product) | The scorer's read; what the score means; what stands out; what to probe; how they line up against the job (seniority, experience, responsibilities covered strongly, partly or not evidenced); the score breakdown; where they sit against the pool's median; eligibility to hire; "Worth checking before you decide" (must-haves it could not check) | [appdetail-js] |
| Integrity notice | Flags hidden text, prompt-injection wording and disguised characters in a candidate's documents, without penalising them | [appdetail-js]; [dpa] Annex 2 |
| Interview | The transcript; lines marked "From the interview" (said in the interview, not on the CV); copy transcript | [appdetail-js] |
| Profile | The profile frozen as it was on applying, including working style, decision making and blind spots | [appdetail-js] |
| Résumé | Preview, full screen, new tab | [appdetail-js]; [whats-new] 18 Jul |
| Notes | Colour-coded sticky notes; quick inserts Strengths, Concerns, Questions and Verdict; templates Interview prep, Debrief, and Pros & cons; autosave; when two people edit at once, "Use theirs" or "Overwrite with mine"; team only | [appdetail-js] |
| History | One timeline of candidate, AI-crew and recruiter events (applied, CV imported, interview started, submitted, withdrew, notes, re-score, email sent, stage moves tagged "with the reviewer" or "AI-suggested"); the last 200 recruiter actions | [appdetail-js] |
| Twin ("Ask <name>") | A chat over the frozen profile only; it cannot change the status. Suggested prompts: strongest evidence, weakest areas, screening answers, a 3-line brief for a hiring manager. | [appdetail-js] [api-js] |
| More actions | Open the CV, head to head, re-score (30 to 60 seconds; the candidate is not told), "Send the candidate a personalised email" | [appdetail-js] |
| Imported CVs | "Write the invite" (invite them to apply); for duplicates, "Remove the import" | [appdetail-js] |

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Jobs list, then a job; dashboard nudge "Review N applicants for <job>"; dashboard "Recent applicants" | INFERRED | [jobslist-js] [dashboard-js] |
| Entry point | Demo chapter 03 | OBSERVED (demo) | [demo] |
| Person and permissions | Every seat holder sees every applicant in the company. | INFERRED | [r-terms] §2 |
| Screens, dialogs, menus | List page with stage pills; right-side drawer over the list; full-screen application page; Tune ranking drawer; stage menu (4.9) | OBSERVED (demo list and drawer); INFERRED (rest) | [demo]; [jobhub-js] |
| Inputs and checks | Search, filters, sorting, bulk selection | INFERRED | [jobhub-js] |
| Loading, error, success | "Waiting for first applications · Live for 2 days."; "No applicants in this stage yet." | OBSERVED-EARLIER (demo) | [demo] |
| Loading, error, success | "Scoring…" status; "Limited data" when scoring ran in a reduced mode | INFERRED | [dashboard-js] |
| Information collected, and when | Nothing new is asked of the recruiter here; notes are optional. | INFERRED | [appdetail-js] |
| Who decides | user: opens, filters and sorts. code: works out the number, band, colour and order. AI: writes the read, verdict, headline and what to probe. | OBSERVED (demo display); INFERRED (who does what) | [demo]; [r-terms] §3 |
| What changes afterwards | Opening a drawer changes nothing visible in the demo. The jobs list shows "N to review" and "N new", so viewing is probably tracked. | UNKNOWN | [jobslist-js] |
| Edge cases and failures | Duplicates; reduced analysis; "Résumé only"; "Verify eligibility"; Withdrawn; the demo's agreement line while still New | INFERRED; OBSERVED (demo slip) | [jobhub-js] [dashboard-js]; [demo] |

*Touches our decisions:* B2 (score with breakdown), B3 (stage strip), Q23 (candidate panel sections), Q24 (private team notes, no ratings).

### 4.6 Scoring, rubric and re-scoring

**In plain words.** Each job has a scoring rubric of 3 to 12 weighted requirements. Kanvis says the number is worked out by fixed rules from the interview record, and the AI only supplies yes-or-no judgements and the wording. The recruiter can change weights, which takes effect at once, or change the rubric itself, which re-scores everyone.

**Sequence: the real product** *(INFERRED)*

1. When the job is written, the "Scorer" drafts a rubric. A second AI reviewer then flags traps, each with a one-click fix or dismiss, and nothing changes until the recruiter saves. *([rubric-js]; [whats-new] 28 Jun)* The traps:
   - a personal quality dressed up as a hard skill;
   - a requirement nobody could prove;
   - a must-have with too little weight;
   - two requirements measuring the same thing.
2. **The Scoring tab** (the demo calls it "Rubric"). *([rubric-js])*
   - 3 to 12 requirements, each of a kind: Skills, Years, Job titles, Duties, Seniority, Education, or Trait (anything you can describe in a sentence).
   - Per requirement: a weight slider; "Must pass" (with a confirmation, "Make this a must-pass?"); "Only you" (counts toward the score but is hidden from the candidate); remove.
   - AI suggestions that can be dismissed, and "Ask the scorer for a fresh proposal".
   - A "Talk to the scorer" chat that proposes changes, answered "Update the scoring" or "Keep it as it is".
   - A radar chart ("Three or more metrics draw a shape.").
3. After the interview, the application is frozen and scored. *([terms] §5B; [recruiter])*
4. **Changes and re-scoring.** *([rubric-js] [jobhub-js])*
   - Changes to weights, names and marks update at once.
   - Changes to the structure re-score everyone, which takes a few minutes.
   - "Re-score all" in Details takes 30 to 60 seconds a person, and candidates are not told.
   - One person can be re-scored on their own.
   - Bulk re-scoring is limited to 5 an hour.
5. "Tune ranking" lets the recruiter drag weights and watch the list re-rank, at once. *([jobhub-js])*

**Rules Kanvis says its scoring follows** *(INFERRED; [whats-new] 27-28 Jun; [r-terms]; [privacy] §2C)*

- Missing information is set aside, not held against anyone.
- Only objective requirements (a degree, a hard skill, permission to work) can rule someone out. People flagged this way keep their real score, sit lower in the list, and show the reason.
- Close skills get partial credit. Something said in the interview can meet a requirement the CV does not show.
- For imported CVs, a requirement a CV cannot prove is "pending", not failed.
- "Too close to call" is shown instead of inventing a gap. Re-ranking the top of the list never changes scores.
- Recorded outcomes (shortlisted, rejected, hired) are used to check that scores are well calibrated.
- The score is not a validated predictor of job performance.

**What the screen shows** *(OBSERVED (demo); [demo] [demo-js])*

- Bands: Strong 85 and up, Solid 70 and up, Worth a look 55 and up, Weak 40 and up, Long shot below. Badge colour: green from 70, amber from 55, grey below. (The words Strong, Solid, Worth a look and Weak and the colours were seen on the demo's cards; the exact cut-offs and "Long shot" are INFERRED from the demo's code.)
- The points lost add up to 100 minus the score (91 = 100 − 9.0). But a loss is not simply weight times shortfall: 25% of an 18% shortfall would be 4.5, and the screen shows 4.1. **The exact formula is UNKNOWN.**
- The candidate also sees a fit score after applying ("The recruiter sees this score with your interview."), in a "candidate-safe" version without private-criteria detail. *(INFERRED; [capp-js]; [dpa] Annex 2)*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | The Scoring tab; the builder's scoring preview; the Tune ranking drawer; Details, "Re-score all" | INFERRED | [rubric-js] [builder-js] [jobhub-js] |
| Person and permissions | Any seat holder; whether a Member may change the rubric is not stated | INFERRED; UNKNOWN | [rubric-js] |
| Screens, dialogs, menus | Rubric editor with sliders and switches; the must-pass confirmation; the scorer chat; Tune ranking drawer | INFERRED | [rubric-js] [jobhub-js] |
| Inputs and checks | 3 to 12 requirements; must-pass confirmation; 5 bulk re-scores an hour | INFERRED | [rubric-js] |
| Loading, error, success | "Rubric proposed."; re-scoring takes minutes; "Limited data" or "Scored with reduced analysis" when scoring ran in a reduced mode | INFERRED | [rubric-js] [dashboard-js] [jobhub-js] |
| Information collected, and when | Requirements when the job is made; evidence during the interview; everything frozen when the candidate sends | INFERRED | [terms] §5B |
| Who decides | AI: proposes the rubric and gives the yes-or-no findings and words. code: works out the number. user: saves the rubric and weights. | INFERRED | [r-terms] §1, §3; [recruiter] |
| What changes afterwards | Scores update or are re-run; candidates are not told | INFERRED | [jobhub-js] |
| Edge cases and failures | Reduced analysis; "pending" requirements for imported CVs; the demo's Rubric tab does nothing | INFERRED; OBSERVED (demo) | [jobhub-js]; [demo] |

*Touches our decisions:* B2 (our number is worked out by code from checked findings; our formula is fixed in `docs/spec/22-match-score-and-pool-board.md` §1) and the 13 October fairness rules.

### 4.7 Decision board and Review & apply

**In plain words.** One button asks the AI to sort the whole pool into Shortlist, Longlist and Pass. Each person gets a one-line reason, two strengths, one gap and a suggested next step. "Review & apply" then lists everyone, already ticked; the recruiter unticks anyone they want to look at personally and presses one button. People are filed into private stages and nobody is emailed.

**Sequence** *(OBSERVED (demo) unless marked)*

1. "Screen the pool" opens /recruiter/jobs/[id]/decisions. *([demo]; [shells])* In the product, a "Generate decisions" dialog first explains that the AI reads every frozen profile against the job. It shows the pool size, the estimated time and the cost: "one LLM call (a few cents on Gemini Flash)". *(INFERRED; [decisions-js])*
2. The board header shows "DECISION BOARD", the title, "Ask AI", "Regenerate" (does nothing in the demo) and "Review & apply 6" ("Apply the AI's recommendations in one go"). Under it: "3 shortlist · 1 longlist · 2 pass · generated just now".
3. A green panel holds "THE AI'S READ ON YOUR POOL" (two sentences) and "RECOMMENDED NEXT STEPS" (three bullets that name people).
4. Three columns: Shortlist ("Strong fits to advance"), Longlist ("Solid — keep warm") and Pass ("Clear no-fits"); an empty column says "None — yet." Each card shows:
   - the name, and the band word with the score;
   - a chip: "Confident", "Needs your eye", or a red "Dealbreaker: <reason>";
   - a one-line headline;
   - two strengths (✓) and one gap (–);
   - a next-action tag with a reason.
5. **The "Review and apply" window.**
   - It tells you to uncheck anyone you want to revisit; the defaults match the AI.
   - Three groups, each with an n/m count. Shortlist files people into the Shortlisted stage, privately. Longlist files them into Longlisted, privately, with no email. Pass files them into Disqualified (not Rejected), privately, with no email; a personal note can be sent later.
   - Each row: a ticked checkbox, the name, the band and score, the reason, and warnings repeated from the board: "Needs your eye — read before committing" (orange) or "Dealbreaker: …" (red).
   - The footer says people are filed privately and nobody is emailed, then shows a live count ("N applications ready to commit (x shortlist · y longlist · z pass)"), Cancel and "Apply N decisions".
6. Unticking changes the counts and the button at once (6 → 5 → 6).
7. **Applying.**
   - On 7 Oct: the toast "Applied 5 decisions" with "Filed into your pipeline privately — nobody emailed." *(OBSERVED-EARLIER)*
   - Filed cards get "Done"; the button loses its badge and stops working.
   - A held-back person stays New, and the list shows a verdict pill such as "Likely no" next to them.
8. **In the product** *(INFERRED; [decisions-js]; [whats-new] 28 Jun, 6 Sep, 22 Sep)*:
   - "Regenerate the whole board?" replaces every card but leaves applied decisions in place.
   - Moves made from the chat can be undone.
   - The board says how many people it read, and each application says whether its read is complete.
   - Duplicates are flagged.

**The demo's six cards** *(OBSERVED (demo); made-up people)*

| Person | Band · score | Column | Chip | Next action (reason, paraphrased) | Gap shown |
|---|---|---|---|---|---|
| Priya | Strong · 91 | Shortlist | Confident | Technical interview (skip the screen) | No SEPA |
| Tom | Strong · 88 | Shortlist | Confident | Phone screen (20 minutes on how close he was to the migration) | Migration second-hand |
| Adaeze | Solid · 84 | Shortlist | Needs your eye | Request info (ask about scale first) | No volume or team-size figure |
| Ben | Solid · 71 | Longlist | Confident | Hold as backup (if the top three don't convert) | No payment rails of his own |
| Lena | Worth a look · 58 | Pass | Confident | Send a pass note | Backend work supporting, not primary |
| Sam | Weak · 44 | Pass | Dealbreaker: no payment rails experience | Send a pass note (fails the hard requirement) | n/a |

Two things the cards show: the band word does not depend on the column (Lena is "Worth a look" yet in Pass), and confidence is separate from the score (Adaeze is shortlisted yet "Needs your eye").

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | "Screen the pool" strip on the Applicants tab | OBSERVED (demo) | [demo] |
| Entry point | "The reviewer's read on your pool" card; dashboard nudges | INFERRED | [jobhub-js] [dashboard-js] |
| Person and permissions | Any seat holder. The board is on every plan, including Free, but pipeline stages are listed as Team plan and up, so what a Free company sees after applying is not known. | INFERRED (plans OBSERVED); UNKNOWN (Free) | [pricing-r] |
| Screens, dialogs, menus | Board page; "Generate decisions" dialog; "Regenerate the whole board?" confirmation; Review and apply window; Ask AI panel (4.8) | OBSERVED (demo); INFERRED (dialogs) | [demo]; [decisions-js] |
| Inputs and checks | Ticks only (demo). Product next actions: Phone screen, Request info, Technical interview, Send a pass note, Hold as backup, Review manually. | OBSERVED (demo); INFERRED | [demo]; [decisions-js] |
| Loading, error, success | "Awaiting scoring"; "Scoring is taking longer than usual" | INFERRED | [decisions-js] |
| Loading, error, success | Toast and "Done" chips | OBSERVED (demo) | [demo] |
| Information collected, and when | Nothing new; the board reads the frozen applications | INFERRED | [decisions-js] |
| Who decides | AI: drafts the columns, reasons and next steps. code: maps each group to a stage and keeps the counts. user: holds people back and commits. | OBSERVED (demo) | [demo] |
| What changes afterwards | Stages are set privately; no email is sent; "Done" chips appear; held-back people do not change | OBSERVED (demo) | [demo] |
| Edge cases and failures | Only Lena can be unticked in the demo, so these are not known: more than one hold-back, changing someone's group, or applying a held-back person later. | UNKNOWN | [demo] |
| Edge cases and failures | No drag-and-drop or column change on the board; cards, tags and arrows do nothing; each chapter resets | OBSERVED (demo) | [demo] |
| Edge cases and failures | Kanvis's terms say committing rejects nobody. The legal text and the /recruiter page call the groups Shortlist, Backup and Reject. | INFERRED (rule); OBSERVED (naming) | [r-terms] §1, §4A; [recruiter] |

*Touches our decisions:* B4 (our Review and apply, built with "Not moving forward" and a reason per person, `docs/spec/22-match-score-and-pool-board.md` §2) and B6 (decisions are private; telling is a separate, later action by a person).

### 4.8 Ask AI about the pool

**In plain words.** A side panel where the recruiter asks questions about the applicants in plain words. In the demo the answers are pre-written examples. The real product's code shows an assistant that can look people up, compare them and move them, asking before it moves anyone.

**Sequence: the demo** *(OBSERVED (demo); [demo])*

1. "Ask AI" on the board opens a right-side panel, "Shortlist AI · Senior Backend Engineer" ("Ask anything about your applicants for this role"). × or Esc closes it.
2. The empty panel shows "Your hiring assistant". It says the assistant has read every applicant and can find, compare, explain or move anyone, citing what it found.
3. "TRY ONE OF THESE" offers four questions: who is strongest so far; compare my top 3; any strong fits I might be overlooking; who fails a must-have, and why.
4. Each answer starts with a chip naming what it looked at (for example "Listed applicants: 6 applicants, ranked", or "Loaded detail: must-have check, 6 rows"), then names people with their scores and the deciding requirement. It is labelled "EXAMPLE", followed by "ALSO WRITTEN DOWN" with the other questions.
5. Typing "who should I phone first?" returns "Answering the closest written question: …" and a pre-written answer. Typing "move Ben to the shortlist" does the same, and nothing moves. The footer says the answers on this page are written down, not generated.

**The real product** *(INFERRED; [reviewer-js] [decisions-js]; [whats-new] 6 Sep; [pricing-r])*

- It lives in the job hub as "Ask about your applicants". Its suggested prompts include moving the strongest candidate to the Shortlist.
- It has four tools, shown as chips: "Listed applicants", "Loaded detail", "Compared candidates" and "Updated application".
- It confirms before any stage change. Moves made from the chat can be undone, and History tags them "with the reviewer".
- The chat history is kept in the browser only.
- "Shortlist QA" (questions across the shortlist, with evidence per person) is on the Pro plan and up.

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | "Ask AI" on the decision board | OBSERVED (demo) | [demo] |
| Entry point | "Ask about your applicants" in the job hub | INFERRED | [reviewer-js] |
| Person and permissions | Pro plan and up for Shortlist QA | INFERRED (plan OBSERVED) | [pricing-r] |
| Screens, dialogs, menus | Right-side panel with suggested questions, answer chips and a typing box | OBSERVED (demo) | [demo] |
| Inputs and checks | Free text; a confirmation before any move | OBSERVED (demo box); INFERRED (confirmation) | [demo]; [reviewer-js] |
| Loading, error, success | Shared AI error lines (4.3) | INFERRED | [sidebar-js] |
| Information collected, and when | None from the recruiter; the history stays in the browser | INFERRED | [reviewer-js] |
| Who decides | AI: answers and proposes moves. user: confirms any move. code: runs the look-ups. | INFERRED | [reviewer-js] |
| What changes afterwards | A confirmed move changes the stage and is recorded in History, where it can be undone | INFERRED | [decisions-js] [appdetail-js] |
| Edge cases and failures | Demo answers are pre-written. History is lost on another browser or device. Limits on what it may answer are not known. | OBSERVED (demo); INFERRED; UNKNOWN | [demo]; [reviewer-js] |

*Touches our decisions:* B5 (one-click questions now; a free-text chat later, after testing on the real model).

### 4.9 Stage moves, hire and close

**In plain words.** Every applicant sits in one of ten private stages. Moving someone is one click from a menu, and the candidate is not told. Hiring is just another stage. A job can be paused, closed for good, or closed automatically at its deadline.

**The ten stages** *(OBSERVED (demo); codes INFERRED; [demo] [stages-js] [dashboard-js])*

| Stage | Code value | Colour |
|---|---|---|
| New | NEW | grey |
| Longlisted | LONGLISTED | grey |
| Shortlisted | SHORTLISTED | green |
| 1st Interview | INTERVIEW_1 | green |
| 2nd Interview | INTERVIEW_2 | green |
| On Hold | ON_HOLD | amber |
| Job Offer | OFFER | green |
| Hired | HIRED | solid green |
| Disqualified | DISQUALIFIED | red |
| Rejected | REJECTED | red |

The dashboard groups them as New, Longlisted, Shortlisted, Interviewing, On hold, Offer/Hired and Rejected (Rejected plus Disqualified). The demo's filter pills show only seven: All, New, Longlisted, Shortlisted, 1st Interview, Hired, Disqualified.

**Sequence: the demo** *(OBSERVED (demo); [demo])*

1. Clicking the stage pill in the drawer opens a "MOVE TO STAGE" menu listing the ten stages, with the current one marked.
2. Only "Move to Hired" works, and it works even before screening (chapter 03).
3. The pill turns solid green at once. A toast says "Moved to Hired." and "Private — the candidate wasn't notified." The counts update, and the list switches to the Hired filter.
4. Re-opening the menu offers no moves, so in the demo a hire cannot be undone. There is no reason box, no confirmation and no email prompt.
5. The film ends with "THAT IS THE WHOLE LOOP", recapping five moves: opened the role, answered three questions, six applied, one pass over the board, made the hire. Its closing line: nobody heard from Kanvis until you chose to send something.

**The real product** *(INFERRED; [appdetail-js] [jobhub-js])*

- The move dialog has an optional reason box: "Why are you moving them here? Saved to their timeline."
- An optional tick sends a follow-up after the move: an interview invite, an offer, or a warm pass. It opens the email composer, and the recruiter still reviews the email before it goes.
- If someone else changed the same person meanwhile, the move is undone (a conflict check).
- People can be moved in bulk from the list, privately. A failed bulk move is undone.
- The assistant can move people after asking (4.8).

**Hire and offer.** "Job Offer" and "Hired" are only stages. "Open an offer" is a kind of email. No offer record, offer letter, e-signature or interview scheduling was found. *(INFERRED (absence); [sweep])*

**What the candidate sees.** *(INFERRED; [capp-js] [r-terms] §6 [jobhub-js])*

- There are two layers. The ten stages are private.
- Separately, the candidate's page shows Applied, Interview, Scored, Recruiter review, then Shortlisted or Not selected. Not selected is shown as "Outcome", with "The recruiter has reviewed your application."
- Kanvis's terms say sending a rejection email is the one action that shows the candidate a rejection. A "warm pass" files the person as "Not selected" and emails them.
- Which action makes a candidate see "Shortlisted" is not known. *(UNKNOWN)*

**Closing a job** *(INFERRED unless marked)*

- **Details tab actions:** Pause hiring and Resume hiring; Close job (cannot be reopened); Delete draft; Export CSV; Re-score all; Import CVs; Post to LinkedIn. *([jobhub-js])*
- **Paused:** visitors see the job but cannot apply. The dashboard nudges "<job> is paused", with "Review and resume". *([jobhub-js] [dashboard-js])*
- **Closed:** the public page becomes read-only, and existing applicants stay available to the team. *([jobslist-js])*
- **Deadline:** the job closes at the end of that day in the company's time zone, and people part-way through can finish. *([whats-new] 26 Aug, 5 Sep; outcome OBSERVED on [job-uplift])*
- **Plan limits:** a role pass that runs out makes its job read-only. After a downgrade, jobs over the new limit become read-only. Nothing is deleted. *([pricing-r])*
- **Stale jobs:** a dashboard list shows days live and applicants, with a hint to adjust the post or share it again. *([dashboard-js])*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Stage pill in the drawer or row; bulk "Move to…"; the assistant; Details actions | OBSERVED (demo pill); INFERRED (rest) | [demo]; [jobhub-js] [appdetail-js] |
| Person and permissions | Any seat holder; pipeline stages are Team plan and up | INFERRED (plans OBSERVED) | [pricing-r] |
| Screens, dialogs, menus | Stage menu; move dialog with reason and follow-up tick; "Close job" (cannot be undone) | OBSERVED (menu); INFERRED (dialog) | [demo]; [appdetail-js] |
| Inputs and checks | Optional reason; conflict check | INFERRED | [appdetail-js] |
| Loading, error, success | Toast "Moved to Hired." / "Private — the candidate wasn't notified." | OBSERVED (demo) | [demo] |
| Loading, error, success | A failed or conflicting move is undone | INFERRED | [appdetail-js] [jobhub-js] |
| Information collected, and when | The reason, if given, is saved to the person's timeline | INFERRED | [appdetail-js] |
| Who decides | user: every move. code: undoes conflicts, closes at the deadline, applies plan limits. | INFERRED | [appdetail-js]; [whats-new] 26 Aug; [pricing-r] |
| What changes afterwards | Stage and counts change; History records the move; the candidate is not told | OBSERVED (demo); INFERRED (History) | [demo]; [appdetail-js] |
| Edge cases and failures | A closed job cannot be reopened yet still looks open on the board; "Hired" cannot be undone in the demo; what a Free company sees without stages is not known | INFERRED; OBSERVED; UNKNOWN | [jobhub-js]; [jobs]; [demo] |

*Touches our decisions:* B3 (stage strip with counts; moves that need a real event open that step), Q25 (declining with a booked interview cancels it), Q29 (a record-only "Offer made"), Q30 (closing message), Q12 (closing date).

### 4.10 Communications: bulk send and sourced invites

**In plain words.** Kanvis never writes to a candidate about a decision on its own. The AI drafts each email; a person edits it and sends it. Bulk sends are personalised one by one and previewed. Recruiters can also upload CVs they already hold and invite those people to apply.

**Sequence** *(INFERRED unless marked)*

1. **One person.** The drawer's "Email" button ("Send the candidate a personalised email"; it does nothing in the demo, OBSERVED) or a follow-up from a stage move opens the composer: "Message (AI-drafted · edit freely)". The text is plain and editable; Kanvis adds a branded frame, a signature and an apply button. *([appdetail-js]; [demo])*
2. **Many people.** Select rows, then answer "What are you sending?": Interview invite, Offer, or Warm pass (reject). Each note is personalised by the AI and previewed before sending. A warm pass files the person as "Not selected" and emails them. *([jobhub-js])*
3. **Import CVs**, from the job. *([jobhub-js]; [whats-new] 27 Jun, 5 Aug; [pricing-r])*
   - Drop PDF, DOCX, DOC or TXT files: up to 50 at a time in the code; the plans allow 10, 25, 25 or 50 per upload.
   - Each row moves through "Ready to import", "Uploading…", "Parsing CV…" and "Scoring against the job…".
   - Imported people are ranked with the applicants and marked "Sourced". Duplicates merge. The original file can be downloaded or deleted.
4. **Invite sourced people to apply.** *([jobhub-js]; [whats-new] 5 Aug)*
   - One message with dark "chips" (merge fields: name, current role, a private apply link) that change for each person.
   - Anyone whose CV cannot fill a chip is held back, with the reason shown.
   - Each recipient can be previewed with arrows, and each email is sent on its own.
   - Failure reasons include no email on the CV, already applied, already invited, and still importing.
   - If the person applies, their real application replaces the import.
5. **Replies.** Candidate replies land in the candidate's Kanvis Inbox. A candidate can reply only after the employer writes first. *([whats-new] 19 Aug; Inbox OBSERVED, empty, [cand])*

**Kanvis's own emails to candidates** (not sent by the recruiter):

- application received, fit report ready, and job closed;
- a notice if nobody decides within 45 days;
- decisions always reach the candidate, and the only way to stop them is to turn off all Kanvis email.

*(OBSERVED (Settings wording, [cand]); 45-day notice INFERRED, [whats-new] 17 Aug)*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Drawer "Email"; stage-move follow-up; bulk send from the list; Import CVs and "Write the invite" | OBSERVED (demo button); INFERRED | [demo]; [appdetail-js] [jobhub-js] |
| Person and permissions | "Candidate comms" is Team plan and up. For imported CVs, the recruiter promises it has a lawful basis and has given notice. | INFERRED (plan OBSERVED) | [pricing-r]; [r-terms] §5 |
| Screens, dialogs, menus | Composer with editable preview; "What are you sending?" picker; per-person preview with arrows; import drop zone with row states | INFERRED | [appdetail-js] [jobhub-js] |
| Inputs and checks | Editable text; merge fields; hold-back when a field cannot be filled | INFERRED | [jobhub-js] |
| Loading, error, success | Import row states; failure reasons per invite | INFERRED | [jobhub-js] |
| Information collected, and when | Imported CVs create a record that only the company sees: no account, no login, no public page. It can be deleted one at a time or in bulk. | INFERRED | [r-terms] §5; [dpa] §8 |
| Who decides | user: sends. AI: drafts and personalises. code: fills merge fields and holds people back. external: the email provider (Resend) delivers, and the customer is the legal sender. | INFERRED | [r-terms] §6; [dpa] Annex 3 |
| What changes afterwards | A warm pass sets "Not selected"; every email is logged in History | INFERRED | [jobhub-js] [appdetail-js] |
| Edge cases and failures | No email-template editor exists. Whether an interview invite carries times or a booking link is not known. Recruiters must not paste private criteria into rejections. | INFERRED; UNKNOWN | [settings-js]; [r-terms] §6 |
| Edge cases and failures | The hiring-team side says "nobody is emailed"; the candidate side says decisions always reach the candidate. Which action sends the decision email is not known. | OBSERVED (both wordings); UNKNOWN (trigger) | [demo]; [cand] |

*Touches our decisions:* B6 (tell later, by a person), Q27 (reminders and the 5-business-day safety net), Q28 (approved wording, AI-suggested personal lines).

### 4.11 Compare, analytics and share

**In plain words.** Each job has three more tabs: a comparison report the team can download and pass on, analytics on who saw the job and who applied, and tracked share links. In the demo all three tabs are labels only.

| Area | Finding | Label | Evidence |
|---|---|---|---|
| Compare: report | A shortlist report. "Edit pool" (choose who is in it); "Download this report as a PDF"; "What this role counts" (requirements, heaviest first, with must-have and private markers); a heat grid; a "Typical applicant" baseline; "Beats typical", "Pool best", "Point spread", "Biggest single lever"; "What's Next" | INFERRED | [jobhub-js] [appdetail-js]; [whats-new] 27 Aug |
| Compare: head to head | Two people side by side ("Compare someone else"; ?view=compare&duel=<id>). A strong candidate who was missed can be pulled into the shortlist. | INFERRED | [jobhub-js]; [whats-new] 27 Aug |
| Analytics: views | Overview, Visits, Drop-off, Applicants (?section=…); All time, 7, 30 or 90 days; a printable header | INFERRED | [jobhub-js] |
| Analytics: funnel | Saw the job, opened the application, started, finished; also applied after looking, average score, reached the shortlist, waiting on you | INFERRED | [jobhub-js] |
| Analytics: sources | Each tracked link plus Kanvis's own sources (job feed, jobs list, after sign-up, careers page, untagged), with the share who applied and the average score. Shown once 20 people have visited. | INFERRED | [jobhub-js] |
| Analytics: drop-off | Completion rate, time to finish, the interview stage where people leave, and which screening question loses candidates. Shown once 20 people have started. | INFERRED | [jobhub-js]; [whats-new] 31 Aug |
| Analytics: who applied | Where they are, years of experience, top skills, the most-missed requirement, who meets every dealbreaker, how many meet each requirement, screening answers | INFERRED | [jobhub-js] |
| Analytics: across jobs | Time to first look, apply to shortlist, apply to hire, once 3 jobs have applicants | INFERRED | [jobhub-js] |
| Analytics: insight cards | About 18 fixed-rule cards, for example: people click Apply and stop; applicants wait days for a first look; almost nobody meets a requirement; later applicants score lower | INFERRED | [jobhub-js] |
| Share tab | "The link" (copy; a note when paused or closed). "Where you're posting": named tracked links that can be added, renamed, copied and removed, and removed links keep working. "Not yet live" for drafts. The LinkedIn composer (4.4). | INFERRED | [jobhub-js] |
| Export | CSV of applicants, from Details | INFERRED | [jobhub-js] [api-js] |
| Plans | Analytics and shareable links are Team plan and up | OBSERVED | [pricing-r] |
| Demo | Compare, Rubric, Analytics, Share and Details are labels only | OBSERVED (demo) | [demo] |

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Job hub tabs (?view=compare, analytics, share, manage) | INFERRED | [jobhub-js] |
| Person and permissions | Any seat holder on Team plan and up (analytics, links) | INFERRED (plans OBSERVED) | [pricing-r] |
| Inputs and checks | Choosing the report's pool; date ranges; link names | INFERRED | [jobhub-js] |
| Loading, error, success | Figures are held back until there are 20 visitors or 20 starts | INFERRED | [jobhub-js] |
| Who decides | code: counts and fixed-rule insight cards (no AI found here). user: picks the pool and shares the report. | INFERRED | [jobhub-js] |
| What changes afterwards | Nothing changes for candidates; reports and links only | INFERRED | [jobhub-js] |
| Edge cases and failures | Early jobs show little; Free and Pro plans have no analytics | INFERRED | [jobhub-js]; [pricing-r] |

*Touches our decisions:* Q11 (channels) and our role Report tab, as a layout reference.

### 4.12 Settings, team and billing

**In plain words.** The hiring-team product is small: a sidebar with four places, one settings page that saves as you type, two roles (Owner and Member), and no billing screens. Plans are bought through the waitlist.

**Sidebar** *(INFERRED, [sidebar-js]; demo version OBSERVED, [demo])*

- A company chip: name, your role and a settings cog.
- "New job" (N).
- Dashboard.
- Jobs, with each job listed underneath: a green dot and applicant count when live, a grey dot when a draft.
- "Workspace settings", Sign out, collapse, and "Open menu" on phones.
- No Candidates or Talent pool, Reports, Billing, Integrations or Team pages.

**Dashboard** at /recruiter/dashboard ("Inbox · <date>") *(INFERRED; [dashboard-js])*

- Number tiles: jobs by status; applicants; this week against last week.
- A pipeline bar.
- "Do this next" nudges that can be dismissed: first job, applicants to review, a draft to publish, a live job to share, a paused job.
- "Top this week" (with "Limited data" when scoring ran in a reduced mode).
- "Recent applicants" (tagged Imported CV or Direct apply).
- "Your roles" (status, new count, Post to LinkedIn, copy link).
- "Stale roles".
- A "Finish setup" banner.
- "Writing as …", with "Edit context →".

**Jobs list** at /recruiter/jobs *(INFERRED, [jobslist-js]; page frame OBSERVED, [shells])*

- "Jobs", "New job (Shift+N)" and a "Search title…" box.
- Filters: All, Live, Drafts, Paused, Closed. Sort: Recent activity, Newest first, Oldest first, Title A→Z.
- Row badges: "N to review", "N new", "Draft · Nd old", "Not live", "No applicants yet", and a "Post to LinkedIn" icon.
- One empty state per filter, for example "You don't have any jobs yet." with "Open your first role".

**Settings** at /recruiter/settings: one page with a section list that stays in view, and "Edits save automatically". *(INFERRED; [settings-js])*

1. **Company:** name (shown in the sidebar, on job pages and during applying), website, organisation type, industry, time zone, default work mode (pre-fills new jobs), hiring philosophy, culture notes (the page says to fill this in once, because every job post uses it).
2. **Your job page** (Team plan and up): cover photo (at least 1500×500, at most 8 MB), brand colour (used on the Apply button), tagline, about, what you offer, tech stack (up to 40), headquarters, team size, with a live desktop and phone preview.
3. **Company library:** documents the AI reads for every job (org chart, values, benefits, culture deck, business plan), each Ready, Queued, Incomplete or Couldn't read.
4. **Team:**
   - Invite (full name, work email, Owner or Member); resend; re-invite with a new link; revoke an invite or a seat.
   - Make owner, change to member, step down. The last owner cannot be removed, and revoked people can be invited again.
   - People are emailed when their access changes.
5. **Notifications:** invites, milestones (first job, first hire), new applications, team changes. Transactional emails cannot be turned off.
6. **Personal:** your title; what you hire for and how you evaluate; job-post voice Balanced, Formal or Casual.
7. **Account:** read-only email, name, role, company handle and website.
8. **Workspace:** "Show me onboarding tips again".

**Not found in any code file** *(INFERRED (absence); [sweep] [settings-js])*: billing or plan management, integrations (applicant tracking systems, calendars, Slack), webhooks, an email-template editor, custom stages, approvals, and any role beyond Owner and Member.

**Plans** *(OBSERVED, unchanged on 14 Oct; [pricing-r])*

| Plan | Price a month (yearly) | Open jobs | Screens a month | Seats | CVs per upload | Adds |
|---|---|---|---|---|---|---|
| Free | $0 | 1 | 25 | 1 | 10 | The full interview, scoring with evidence, the decision board, a Twin per application |
| Pro | $49 ($41) | 3 | 150 | 1 | 25 | Shortlist QA |
| Team | $249 ($208) | 10 | 750 | 3, then $39 each | 25 | Pipeline stages, candidate emails, analytics, share links, custom branding |
| Scale | $899 ($749) | 50 | 5,000 | whole team | 50 | |
| Enterprise | custom | custom | custom | custom | custom | Single sign-on, data processing agreement, service levels, a named contact |

- A "screen" is one applicant interviewed and scored.
- Usage may run 20% over the allowance before costing $1.50 a screen. Paying yearly saves about 17%.
- Role passes: $99 (1 job), $399 (5) or $699 (10). Each job gets 150 screens and lasts 60 days once started.
- Kanvis says evaluation is the same on every plan.
- Every plan button goes to the waitlist; no checkout exists.

**Shared loading and error screens** *(INFERRED; [ws-js] [sidebar-js])*

- Skeleton loaders while pages load.
- A panel error, "Something went wrong" ("Nothing you were working on is affected."), with "Reload this panel" and "Back to dashboard".
- "Couldn't reach Kanvis" ("Your account is fine."), with a retry.
- The suspended-workspace screen (4.1).

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Sidebar "Workspace settings"; the company cog; settings anchors (#company, #job-page, #library, #team, #notifications, #personal, #account, #workspace) | INFERRED | [sidebar-js] [settings-js] |
| Person and permissions | Owners manage the team; what a Member may change is not known. All seat holders see all applicant data. | INFERRED; UNKNOWN | [settings-js]; [r-terms] §2 |
| Inputs and checks | Cover photo size; brand colour as a hex code; up to 40 tech-stack items; the last owner is protected | INFERRED | [settings-js] |
| Loading, error, success | Autosave; skeletons; panel error; network error; suspended screen | INFERRED | [settings-js] [ws-js] |
| Information collected, and when | Company context once, then edited any time; personal context per recruiter | INFERRED | [settings-js] |
| Who decides | user: the owner manages the team and settings. code: protects the last owner and gates features by plan. external: Kanvis staff handle plans and billing outside the product. | INFERRED | [settings-js]; [pricing-r] |
| What changes afterwards | Company context and voice feed every new post; branding shows on job pages | INFERRED | [settings-js] |
| Edge cases and failures | Last owner; suspended company; how plan limits are enforced in the product is not known; the trial is promised but not found in code | INFERRED; UNKNOWN | [settings-js] [ws-js]; [sweep] |

*Touches our decisions:* B7 (open sign-up) and Q31 to Q33 (ITS recruiter requests; Kanvis has no in-product recruiter help). For comparison, our team roles are owner, admin, hiring manager, interviewer and HR (`packages/contracts/src/api/index.ts`, `TeamRole`); Kanvis has two.

---

## 5. Candidate journeys

Same format as section 4. On the candidate side we saw more, because the founder's own candidate account could be read. But we never applied, and on 14 October we triggered no AI writing (the profile builder's AI was watched on 7 October), so the interview and all AI output remain OBSERVED-EARLIER or INFERRED.

### 5.1 Job discovery and filters

**In plain words.** Anyone can browse /jobs. A signed-in candidate gets a personal board instead, ordered by how well each job matches their profile, with honest labels when the match is weak.

**Sequence: signed out** *(OBSERVED unless marked; [jobs])*

1. /jobs shows "Discover Jobs made for You! Apply in seconds." and 17 job cards.
2. Filters: Remote, Hybrid or On-site; Function (29 choices); Level (several at once, and jobs that state no level are hidden while it is set); Posted. There is a search box ("Search a role, skill or company…"), "Clear all" and a "By city" list. *(Search, "Clear all", "By city" and the 29 choices come from the 7 Oct reading of the page and its code: OBSERVED-EARLIER or INFERRED; [board-js])*
3. Each card shows the type and work mode, pay if set, "Posted X ago", the title, the location, about 300 characters of the description, and the logo and company. Closed jobs look the same as open ones.
4. Under the list: "Complete your profile once to unlock personalized job matching and one-tap apply." with an "Upload Resume" button.

**Sequence: signed in** *(OBSERVED; [cand])*

1. /jobs redirects to /candidate/workspace?tool=browse_jobs: "Browse Jobs", "1 role matched to your profile.", a refresh button and "My applications".
2. A search box ("Search roles or companies…"), a For You / Recent switch and a Filters button. Quick chips: Posted, Workplace, Job type, Match, Has salary (7) and Saved.
3. Results come in tiers with plain labels.
   - First, the matched jobs.
   - Then "Then we lowered the match bar": cards with a match ring (for example 33).
   - Then "Then we stopped filtering": six jobs "ranked by similarity, not scored", with no ring.
   - At the end: "That's every open role we have — 7 shown."
4. **The Filters panel** (opened only; nothing selected).
   - "HIDE ANYTHING MENTIONING", a box to exclude words (for example internship, commission-only).
   - Posted (seven ranges). Workplace, Job type, Role (9 functions), Level, Skills (about 40) and Company (12), each with counts. A note says 2 jobs without a level are hidden while Level is set.
   - Match: Any, 40%+, 55%+ or 70%+. A note says only scored jobs carry a percentage.
5. **"View" opens a right-side panel** over the board.
   - Top: "Save this role", open the full page, close.
   - For a matched-tier job, a "WHY THIS IS ON YOUR BOARD" box: the tier name, "Matches 0 of 10 listed skills", "Not evidenced yet:" and the missing skills, the level, and "Remote" with the job's own words quoted.
   - Then the posting. At the bottom: "Not interested" and "Apply with your profile" (not pressed).

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | /jobs; a shared link carrying ?src=; a company careers page; Google; "More roles on Kanvis"; the weekly "New roles that fit you" email | OBSERVED (pages, email setting); INFERRED (Google, tags) | [jobs] [careers] [cand]; [apply-js] |
| Person and permissions | Anyone; a signed-in candidate gets the personal board | OBSERVED | [jobs]; [cand] |
| Screens, dialogs, menus | Board; Filters panel (accordion); right-side job panel; full job page | OBSERVED | [cand] |
| Inputs and checks | Filters, word exclusion, save | OBSERVED | [cand] |
| Inputs and checks | Code filters: Any match, Has salary, Saved only, Applied only; previous and next job in the panel | INFERRED | [cws-js] |
| Loading, error, success | "No close matches yet. Showing other open roles." | INFERRED | [cws-js] |
| Information collected, and when | The Job matching settings: countries you can work in, countries you would work in person, "Open to roles anywhere", job types (Full-time, Part-time, Contract, Internship, Freelance) | OBSERVED | [cand] |
| Who decides | user: filters and choices. code: tiers and filters. Whether the match itself is fixed rules or AI is not known. | OBSERVED; UNKNOWN | [cand] |
| What changes afterwards | Saved jobs. What "Not interested" does is not known. | OBSERVED; UNKNOWN | [cand] |
| Edge cases and failures | Only 7 of 17 jobs shown, with no reason on screen (probably the Job matching settings). | OBSERVED; INFERRED (reason) | [cand] |
| Edge cases and failures | Closed jobs listed as if open on the public board. | OBSERVED | [jobs] |
| Edge cases and failures | Jobs collected from other sites (Workable is named) are mixed in with nothing to tell them apart. Jobs a candidate is not eligible for are removed rather than ranked low. Employers may pay to move up, but only among jobs the candidate already matches. | INFERRED | [privacy] §5; [terms] §2A |

### 5.2 Job page and apply entry

**In plain words.** The job page explains the role and promises a short chat-style interview instead of a cover letter. Pressing Apply opens a window on the same page. What comes next depends on whether the person is signed in and already has a profile.

**Sequence** *(page OBSERVED; flow INFERRED from code)*

1. The candidate reads the job page (4.4) and presses "Apply for this role", or "Apply with your profile" from the board's job panel. Neither was pressed. *(OBSERVED (buttons); [job-pattern] [cand])*
2. A window opens, "Applying to {Title} · {Company}", and Kanvis records a job view. Then one of four branches *([apply-js] [signin-js])*:
   - **Signed out:** "New applicant" / "Apply with your résumé", then "Sign in to apply": Google, or email with a 6-digit code ("Resend code in Ns"). No passwords.
   - **A hiring-team account:** "Apply requires a candidate account".
   - **A candidate with no published profile:** sent to /candidate/upload?apply_to=<job>.
   - **A candidate with a profile:** "Applying as {name}", "Verified Kanvis profile · ready" and "Start your application" (about 5 to 10 minutes, a short interview tailored to this role).
3. **No profile yet.** *([upload-js] [cbuild-js])*
   - Upload a PDF or DOCX of up to 10 MB. It is read while the person watches ("Please keep this window open…"), then they confirm their name and email. The email is locked if they signed in with it.
   - A CV that belongs to an existing account asks them to sign in with the email on that CV.
   - Then the profile builder opens with a banner: "Your Portfolio is the Application", "Only This Once" (every later application is a single tap) and "Your spot for <role> is saved…".
   - The last button reads "Continue to Interview" instead of "Complete Onboarding". The work-preference and career-interest steps seem to be skipped.
4. **Coming back later**, the job page shows "Continue application", or "Your résumé is saved. A short interview about this role sends it for review." with "Finish my application". *([jobpage-js])*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Job page; the board's job panel; the address /jobs/<id>?apply=1 | OBSERVED (buttons); INFERRED (address) | [job-pattern] [cand]; [candroutes-js] |
| Person and permissions | Candidates only; one sign-in cannot be both candidate and hiring team | INFERRED | [apply-js]; [r-terms] §2 |
| Screens, dialogs, menus | Apply window on the job page; sign-in window; upload page; builder with banner | INFERRED | [apply-js] [signin-js] [upload-js] [cbuild-js] |
| Inputs and checks | CV file type and size; name and email confirmation; 6-digit code | INFERRED | [upload-js] [signin-js] |
| Loading, error, success | "You've already applied to this role."; "Publish your Kanvis profile first."; "This role is no longer accepting applications."; required questions left; the company not accepting applications | INFERRED | [api-js] |
| Loading, error, success | The monthly limit: "50 of 50 applications left this month" | OBSERVED | [cand] |
| Information collected, and when | Email at sign-in; the CV at upload; the profile in the builder; everything else in the interview (5.3) | INFERRED | [apply-js] [upload-js] |
| Who decides | user: the candidate. code: picks the branch from the sign-in and profile state. external: Google, or the email code. | INFERRED | [apply-js] |
| What changes afterwards | An application in progress, with the spot saved | INFERRED | [cbuild-js] [jobpage-js] |
| Edge cases and failures | A person can start before signing up; the session carries over at sign-in; empty sessions close after 60 days without use and are removed after 90. | INFERRED | [terms] §3B; [privacy] §8 |
| Edge cases and failures | Per job, the code knows four routes: interview, résumé only, direct (only when the job has no required questions), and imported CV. Another way to apply can be arranged on request. | INFERRED | [jobpage-js] [api-js]; [r-terms] §4B |
| Edge cases and failures | For jobs collected from other sites, Kanvis fills in the employer's own form as a limited agent, with no score. This sits awkwardly with /what-is-kanvis, which says Kanvis never applies for you. | INFERRED; OBSERVED (what-is wording) | [terms] §5A; [what-is] |
| Not checked on 14 Oct | The signed-out window: signing out of the founder's account was not allowed. | n/a | n/a |

### 5.3 The AI interview, review and send

**In plain words.** After Apply, Kanvis prepares an interview from the job and the candidate's profile. It asks one question at a time, in text, and follows up on the candidate's own words. The candidate checks every answer before sending. Once sent, the application is frozen and scored within about a minute. *None of this was run by us: it comes from Kanvis's code, its own texts and the demo's sample transcript.*

**Sequence** *(INFERRED unless marked)*

1. **"Setting up your interview"** walks through four steps: reading the role, checking what this employer asks, matching it against your profile, and writing your first question. It then reports "{i} of {t} already answered", or, if all are answered, that "we just want to talk about the role". The candidate lands on /candidate/applications/<id>?focus=interview. *([apply-js])*
2. Three steps are shown, Details, Interview and Review, with a paperclip for attachments. *([whats-new] 14 Aug)*
3. Before starting, the candidate is told it is AI, what it is for, and that it is a conversation, not a test. *([recruiter]; [terms] §5A)*
4. **One question at a time.** *([r-terms] §3; [whats-new] 12 Aug)*
   - Code chooses each question from the job's requirements, the employer's own questions, the private criteria (turned into neutral topics) and the gaps in the profile.
   - The AI only words the question, has no tools and cannot change the record.
   - Questions the profile already answers are skipped.
5. Follow-ups build on the candidate's own words. The demo's sample transcript shows two, about merchants that failed reconciliation and a bug both systems shared. *(OBSERVED (demo sample); [demo])*
6. Employer questions use small answer widgets: yes or no, pick one (a dropdown above 7 options), pick several, short text, long text, a number (with limits) or a date. Required ones are marked *. *([answers-js])*
7. **Answers Kanvis already has.** *([answers-js]; [terms] §5A; [whats-new] 12 Aug, 6 Sep)*
   - Answers pre-written from the profile say "Suggested from your profile — check it", and never count toward the score.
   - Sensitive answers are a "Private detail", stored once and shared only with a company whose form asks for it.
   - Answers that go stale, such as expected salary, are asked again.
8. **Declining and equal-opportunity questions.** *([terms] §5A; [privacy] §10A)*
   - Any question can be declined, and the recruiter sees it as a decline.
   - Equal-opportunity questions appear only when the employer's form requires them. Declining one is never turned into "no".
   - These answers never reach the score, the profile or any AI.
9. Answers save automatically behind one "saved" indicator. The interview can be paused and resumed with the transcript kept ("Pick up where you left off", "Resume interview"). *([whats-new] 22 Aug; [cws-js])*
10. **Review.** Every question and answer is listed with Edit. A section "From your interview" says the answers were written up from the candidate's replies and invites them to fix anything that came out wrong. Nothing is sent until "Send application". *([whats-new] 13 Aug; [capp-js])*
11. **Sending freezes the application.** The profile, job, company, transcript and rubric are saved as they stand and never recalculated. The page says "Your application has been sent." and "Analyzing your fit against the JD." (30 to 60 seconds). It refreshes every 5 seconds and shows confetti. *([terms] §5B; [jobpage-js])*

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | "Start your application" or "Continue to Interview" | INFERRED | [apply-js] [cbuild-js] |
| Person and permissions | The candidate; the employer's private criteria reach the interviewer only as neutral topics | INFERRED | [r-terms] §7 |
| Screens, dialogs, menus | Preparation screen; three-step interview page; review page | INFERRED | [apply-js]; [whats-new] 13-14 Aug |
| Inputs and checks | Answer widgets with required marks and limits | INFERRED | [answers-js] |
| Loading, error, success | Preparation steps; the "saved" indicator; "Analyzing your fit…"; confetti | INFERRED | [apply-js] [jobpage-js] |
| Information collected, and when | Answers during the interview; "learned facts" are kept so later interviews do not ask again, and the candidate can see and delete them | INFERRED | [privacy] §2A |
| Who decides | code: picks the questions and works out the score. AI: words the questions and writes up the answers. user: the candidate answers, edits and sends. | INFERRED | [r-terms] §3 |
| What changes afterwards | A frozen application, scored within about a minute; the recruiter sees it with its score | INFERRED | [terms] §5B; [jobpage-js] |
| Edge cases and failures | Length: about 10 minutes on /recruiter, 5 to 10 on job pages, but one employer's own description says 15 to 20; the home page sample shows "Question 3 of 6". Real length is not known. | OBSERVED (wordings; the 15 to 20 is OBSERVED-EARLIER, 7 Oct); UNKNOWN (real) | [recruiter] [job-pattern] [home]; [job-uplift] (7 Oct) |
| Edge cases and failures | Voice: dictation exists (audio deleted after it is turned into text); voice-session code exists, but the legal text says text only. | INFERRED; UNKNOWN | [privacy] §2A; [api-js] |
| Edge cases and failures | If the job closes midway, the candidate can still finish. After sending, a candidate can withdraw ("Your snapshot is still on file"). | INFERRED | [whats-new] 26 Aug; [capp-js] |

*Touches our decisions:* B1 (the screening conversation in the same visit as applying, with "Do this later" and "Talk to a person"), and the 9 Oct follow-up (unsent answers stay hidden until the candidate presses Send).

### 5.4 Application tracking, messages and emails

**In plain words.** The candidate's Applications list shows each application's progress, their fit score, and finally "Shortlisted" or a gentle "Outcome". An Inbox holds replies from employers. Kanvis emails at each step and always passes on decisions.

**Sequence**

1. **Applications** (OBSERVED, empty; [cand]): "Every role you've applied to through Kanvis…", a refresh button, "Browse open roles", "50 of 50 applications left this month" with a meter, and "No applications yet."
2. **With applications** *(INFERRED; [capp-js] [cws-js])*: "Pick up where you left off", "Interview in progress", "Finish my application" or "Resume interview".
3. **Progress** *(INFERRED; [capp-js] [answers-js])*: Applied, Interview, Scoring or Scored, Recruiter review, then Shortlisted or Not selected. For jobs collected from other sites: Sent to employer, then Employer review.
4. **After scoring** *(INFERRED; [capp-js] [jobpage-js]; [dpa] Annex 2)*:
   - "Your fit score is ready." and "The recruiter sees this score with your interview."
   - The job page gains three tabs, "The role", "Your application" and "Your answers", with "Applied · NN/100", "See your score" and "See the decision".
   - The breakdown shown is the "candidate-safe" one, without private-criteria detail.
5. **Shortlisted:** "The recruiter shortlisted you for <job>." and "Look out for outreach from the team". **Not selected:** the heading "Outcome", with "The recruiter has reviewed your application." *(INFERRED; [capp-js])*
6. **Inbox** (OBSERVED, empty; [cand]): replies from employers and recruiters, answered without leaving Kanvis. A candidate can reply only after the employer writes first. *(INFERRED; [whats-new] 19 Aug)*
7. **Emails** (OBSERVED in Settings; [cand]):
   - application updates (received, fit report ready, job closed);
   - new roles that fit you (weekly);
   - profile and Twin activity;
   - product news;
   - "Decisions on your applications always reach you"; only turning off "All Kanvis emails" stops them.

   A notice when nobody decides within 45 days is INFERRED ([whats-new] 17 Aug).

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Sidebar "Applications"; "My applications" on the board; the job page's "Your application" tab; emails | OBSERVED (sidebar, board); INFERRED (tabs) | [cand]; [jobpage-js] |
| Person and permissions | The candidate | OBSERVED | [cand] |
| Screens, dialogs, menus | Applications list; application page with progress; job-page tabs; Inbox | OBSERVED (list, Inbox); INFERRED (rest) | [cand]; [capp-js] |
| Inputs and checks | Replies in the Inbox; withdrawal | INFERRED | [whats-new] 19 Aug; [capp-js] |
| Loading, error, success | Empty states for Applications and Inbox ("Nothing yet") | OBSERVED | [cand] |
| Information collected, and when | Nothing new; the application was frozen at sending | INFERRED | [terms] §5B |
| Who decides | user: the recruiter's actions change the status (which action triggers "Shortlisted" is not known). code: refreshes the page and sends Kanvis's emails. | INFERRED; UNKNOWN | [capp-js]; [r-terms] §6 |
| What changes afterwards | Status, score, decision; emails | INFERRED | [capp-js] |
| Edge cases and failures | Candidates may ask for a human review, a plain explanation of a score, or deletion, by emailing Kanvis; there is no self-serve delete. Tracking with real applications was never seen. | INFERRED; UNKNOWN | [privacy] §5C, §9 |

*Touches our decisions:* Q14 (our status page opens only from the emailed link), B6 and Q27 (telling candidates), and the 9 Oct choice to keep the 30-day "still reviewing" note off by default.

### 5.5 Profile building and visibility

**In plain words.** A candidate drops in a CV. In about 30 seconds Kanvis turns it into a structured profile; then the AI asks one follow-up question at a time and keeps a short to-do list. The profile is published automatically at a web address the candidate chooses. It can be hidden from search, but not taken down.

**Sequence** *(OBSERVED-EARLIER on 7 Oct in the founder's account; later state OBSERVED on 14 Oct; [cand])*

1. /candidate/build ("Build Portfolio") has two panes: on the left, a chat with the builder (Kanvis calls it Azmuth); on the right, "YOUR RECORD", which saves itself ("Saving…") and has a Preview. The first message asks for the CV, with a drop zone ("Drop your resume here — PDF or DOCX") or "I don't have one, let's build it manually".
2. "Organizing skills & projects" takes about 30 seconds ("Please keep this window open…"). The record fills in: headline, location, a summary written in the third person, skills, jobs, education, projects, awards and links.
3. An "ACTION PLAN 0/4" card lists gaps specific to this CV. Each has an explanation, "Ask the agent about …" and "Mark … done". In code the items move through Active, Pending, Completed and Skipped. *(code INFERRED; [cbuild-js])*
4. The builder praises one concrete achievement and asks one follow-up grounded in the CV. "Nothing to add" moves on to the next item, and each turn rewrites the headline and summary. Entries the AI proposes need "Add to my record" or "Edit the wording". *(code INFERRED; [cbuild-js])*
5. "Complete Onboarding →" leads to /candidate/publish to choose a username: 3 to 30 characters of letters, numbers and hyphens, with an availability check and suggestions. "Publish portfolio" ends on "ONBOARDING COMPLETE", with Copy link, Share, View, Post on LinkedIn, Send on WhatsApp and Go to workspace. There is no choice to keep the profile unlisted before publishing.
6. Until onboarding is complete, the workspace, Job Match, Résumé and Share are locked.
7. **On 14 Oct** /candidate/build redirects to the workspace. "Edit portfolio" shows the same chat thread beside an Edit/Preview record:
   - photo, name, headline, location and summary;
   - skills as removable chips, with Add and "Ask the agent to improve skills";
   - sections with counts, each with "Add to …" and "Ask the agent to improve …": Skills, Work experience, Education, Projects, Awards, Certifications, Questions & answers, How you work, Links, What drives the work, Social impact and Activities.

   A work entry has Role*, Company*, Location, Type (8 kinds, including Military service and Founder), start and end month, Summary, What you did, Results, Metrics and Skills used. Projects have a type (Personal, Academic, Open source, Professional) and a link; education has a GPA. No entry has any source or evidence field.

**Visibility** *(OBSERVED on 14 Oct unless marked; [cand])*

- A "Show in search" switch in the user menu: on means "Recruiters can find you"; off means "Only people with your link".
- Settings, Public profile: copy the link. "Show in search" removes the profile from Kanvis search, the sitemap and featured lists, and the link keeps working. "There's no unpublish…"
- Changing the username breaks the old link (Settings, Profile).
- Checked: with the switch off, the profile is absent from the sitemap, /people and the Islamabad city page (first page checked).
- Elsewhere Kanvis says a profile stays private until you say otherwise. That contradicts automatic publishing with no way to unpublish. *(OBSERVED wording; [what-is])*

**The public profile** *(OBSERVED; [profiles] [cand])*

- **Header:** name, tagline, location, current role, experience; "Hire me" (goes to the hiring-team waitlist with the candidate attached); "Résumé" (downloads the default résumé); Share; social links.
- **Tabs:** Overview, Experience, Skills, Projects, Education, Recognition and Approach (only tabs with data appear). Also the Twin box (5.6) and "More people on Kanvis".
- **Evidence:** Kanvis promises that every entry links to the conversation it came from ([llms] [what-is] [home]). No entry shows a link, not even to the owner. The page data does hold a numeric chat reference on some entries, plus skill proficiency and evidence fields that are never shown.
- **Views and the directory:** profile views are recorded with a hashed IP address, and the candidate is emailed on the first view by a stranger *(INFERRED; [privacy] §2B; [whats-new] 22 Sep)*. The /people directory has city and skill pages and no search.

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | "Build your profile" on the home page (which promises a profile in about five minutes); "Upload Resume" on /jobs; applying without a profile | OBSERVED | [home] [jobs] |
| Person and permissions | The candidate. Anyone can start before signing up; minimum age 16. | INFERRED | [terms] §3B; [privacy] §12 |
| Screens, dialogs, menus | Two-pane builder; action-plan card; username page; Edit portfolio; Settings window; user menu | OBSERVED-EARLIER; OBSERVED | [cand] |
| Inputs and checks | CV (PDF or DOCX; 10 MB on upload; files up to 50 MB in the builder chat); username rules; required Role and Company | OBSERVED; INFERRED (sizes) | [cand]; [upload-js]; [whats-new] |
| Loading, error, success | "Organizing skills & projects"; "Saving…"; "All items complete — your profile is ready!" | OBSERVED-EARLIER; INFERRED | [cand]; [cbuild-js] |
| Information collected, and when | CV at the start; follow-ups during building; optional work-style answers (communication style, decision making, feedback preferences, energizers and drainers, blind spots, leadership philosophy, operating principles); job-matching settings later | OBSERVED; INFERRED | [cand]; [cbuild-js] |
| Who decides | AI: reads the CV, writes the summary, proposes entries and to-dos. user: the candidate confirms and edits. code: publishes automatically and checks username rules. | OBSERVED-EARLIER; INFERRED | [cand]; [terms] §2A |
| What changes afterwards | A live public profile at kanvis.me/<username>, in search unless switched off | OBSERVED | [cand] |
| Edge cases and failures | A CV already used by another account; "nothing to add"; no unlisted option before publishing; a username change breaks the old link; deletion only by email request (done within 30 days) | OBSERVED; INFERRED | [cand]; [cbuild-js]; [privacy] §8 |

### 5.6 AI Twin

**In plain words.** Every public profile has a chat box where a visitor can ask the profile's AI "twin" questions. Hiring teams also get a twin for each applicant, frozen at the moment of applying.

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | A box on every public profile: "Ask <first name>'s twin anything…", with 3 starter questions | OBSERVED | [profiles] [cand] |
| Person and permissions | Any visitor, without signing in; the chat lasts for the visit only; messages up to 1,000 characters | INFERRED | [twin-js] |
| Screens, dialogs, menus | A docked chat box with starter chips; "Answers come from this profile."; a notice that it is an AI representation and can make mistakes | OBSERVED | [profiles] |
| What it answers from | The profile record only | INFERRED | [llms] |
| Information collected, and when | The candidate is emailed when the twin gets a question it could not answer (a setting under Emails) | OBSERVED (setting); INFERRED (behaviour) | [cand] |
| The hiring team's twin | "Ask <name>" in the applicant drawer, over the frozen profile. It cannot change the status. On every plan ("Per-application Twin"). | INFERRED; OBSERVED (pricing) | [appdetail-js]; [pricing-r] |
| Who decides | AI: answers. Whether the candidate can correct or limit its answers is not known. | INFERRED; UNKNOWN | [twin-js] |
| Answer quality, sources, refusals | Not tested: sending a message to a real person's twin was outside our rules | UNKNOWN | n/a |

### 5.7 Résumé, cover letter, outreach and job-fit tools

**In plain words.** In the workspace a candidate can chat with an assistant or open a tool. Each tool starts from the profile, asks for one or two optional details, and produces something to edit and download. None of them sends anything to an employer.

**Workspace home** *(OBSERVED; [cand])*

- **Sidebar:** profile chip with link; New chat; Applications; Inbox; TOOLS: Edit portfolio, Resume, Job Match, Browse Jobs, Outreach and Cover letter; the user chip.
- **Centre:** the date, "WORKSPACE", a greeting, "Your portfolio is live…", the profile link with copy and open, and a chat box ("Message your AI…") with add file or tool, dictation and send.
- **Quick prompts:** Improve my portfolio, Build me a résumé, Find jobs that fit me, Analyze a JD. Then a "USE A TOOL" grid.
- **Chat history:** the sidebar has no list of past chats, although the code mentions archived chats *(INFERRED; [cws-js])*.

| Tool | What we saw (OBSERVED, 14 Oct; [cand]) | What the code says happens next (INFERRED; [cws-js] [jdfit-js]) |
|---|---|---|
| Résumé (?tool=resume) | A list, "Every STAR resume you've generated"; the Default one is served from the public profile. A card "Public profile resume · Modern Compact · Oct 7, 2026" with DEFAULT and STALE badges (stale probably means the profile changed since). Delete is disabled for the default. Clicking opens a PDF preview with Download and new tab. "New resume": one page, ATS-safe, from the verified profile. "PICK A STYLE": Modern Compact, Executive, Tech Builder, Academic (two marked "match"). Optional "Tailor to a specific job description". "Generate resume" (not pressed). | One page in the STAR format. Drag to reorder, remove bullets and highlights, live preview ("Updating preview…"), Download PDF, full-screen preview. A saved list with paging. Several saved versions, not line-by-line history. |
| Cover letter (?tool=cover_letter) | "Tailor to a role (optional)" (up to 500 characters: a role, company or short job description); "Generate cover letter" (not pressed) | Edit line by line; "Make it more concise"; Download as PDF; "All cover letters"; delete |
| Outreach (?tool=email) | "Who are you writing to?" (optional, up to 200 characters); "What should we mention?" (optional, up to 500); tone Warm, Direct or Formal; "Generate draft" (not pressed) | Regenerate; fill placeholders (Enter) or skip them (Esc); "Copies and opens LinkedIn messages", or email. The candidate sends it. |
| Job Match (?tool=jd_analysis) | The list explains it shows your fit, what is missing and whether it is worth applying, in about a minute; "No job matches yet." "Add a job posting" has three tabs: Upload a file (.pdf or .docx, 5 MB), Paste text, and Jobs on Kanvis (pick a matched job; no copying). "Run analysis" is disabled until there is input; it takes 30 to 60 seconds, with a nudge to improve the profile first. | Progress steps (reading title and seniority, extracting skills, must-have against nice-to-have, matching, strengths and gaps, the action plan). Verdict: Strong fit, Partial fit, A stretch or Unlikely fit (the saved list also uses Solid fit and Weak fit). Sections: "A plain read on the job", "Where you align", "Where you fall short", "What to learn", and an action plan in order (This week, Next 2 weeks, Before applying, After offer). "Download report" (PDF); "Generate a resume to apply →". |
| Workspace chat | The chat box and quick prompts | "I'll update your live profile as we talk." Memories (for example "keep replies short") are kept only with the candidate's say-so, and are never put on the profile or sent to a company. |
| Your data (Settings) | Four stores, after "Loading… Fetching what we hold.": saved application answers (so "the next form doesn't ask you twice"), identity details (for example a date of birth, sent only to a company whose form asks), files, and assistant memories. Removing an answer does not change applications already sent. | n/a |

**Detail**

| Aspect | Finding | Label | Evidence |
|---|---|---|---|
| Entry point | Sidebar tools; the "USE A TOOL" grid; quick prompts; "Generate a resume to apply →" from Job Match | OBSERVED; INFERRED | [cand]; [jdfit-js] |
| Person and permissions | The candidate, after onboarding (the tools are locked until then) | OBSERVED-EARLIER | [cand] |
| Inputs and checks | Optional short fields with character limits; file type and 5 MB limit; "Run analysis" disabled until there is input | OBSERVED | [cand] |
| Loading, error, success | Empty lists; progress steps; STALE badge | OBSERVED; INFERRED | [cand]; [jdfit-js] |
| Information collected, and when | Only what the tool asks for, each time; everything else comes from the profile | OBSERVED | [cand] |
| Who decides | user: picks the style, tone and inputs, and presses Generate. AI: writes. user: edits and sends. Kanvis sends nothing to employers. | OBSERVED (inputs); INFERRED (output) | [cand]; [what-is] |
| What changes afterwards | A new saved item; the default résumé on the public profile | OBSERVED; INFERRED | [cand] |
| Edge cases and failures | The default résumé cannot be deleted; the style names on screen differ from the template names in code (3.3, #15); output quality is not known, because nothing was generated | OBSERVED; UNKNOWN | [cand]; [cws-js] |

---

## 6. Interaction design patterns, and why Kanvis feels simpler

**In plain words.** Kanvis feels simple because each screen does one thing, the AI reads and fills in first so people check rather than type, the next step is always suggested, and the product says plainly what did and did not happen. It is also smaller than it looks: there are fewer roles, fewer screens and fewer rules than in our product. Section 6.3 lists what that costs.

### 6.1 Patterns (checklist C and more)

| # | Pattern (checklist item) | What Kanvis does | Why it feels simpler | Label | Evidence |
|---|---|---|---|---|---|
| 1 | Talk for judgement, tap for facts (C1) | Job facts are taps (the 10-step quick start). The profile, the interview and post refinement are chats. Candidate tools ask for one to three optional fields. No long form is visible anywhere. | Each screen asks for one kind of thing, in the easiest way to give it | OBSERVED (demo, tools); INFERRED (quick start) | [demo] [cand]; [newjob-js] |
| 2 | One question at a time, with a count (C3) | The "1 OF 3" card replaces the chat box; "Step N of 10"; the builder asks one follow-up per turn; the home page sample shows "Question 3 of 6" | People always know how much is left | OBSERVED; INFERRED (quick start) | [demo] [cand] [home]; [newjob-js] |
| 3 | Show more only when needed (C2) | The experience follow-up appears only if a minimum is set; skills come after the basics; "Choose them later"; drawers over lists; collapsed sections with counts; accordion filters; "2 more requirements at full marks." | Screens stay short; detail is one click away | OBSERVED; INFERRED | [demo] [cand]; [newjob-js] |
| 4 | Read it first, then let the person check (C5) | The job description, website and CV are read and filled in, then marked: "Filled in from your job description.", "From you" or "Website", "Suggested from your profile — check it", "Looks right, finish setup" | Typing becomes checking, and the source is visible | INFERRED (hiring side); OBSERVED-EARLIER (CV) | [newjob-js] [onb-js] [answers-js]; [cand] |
| 5 | AI output is always editable (C4) | A review step with Edit on every row; every profile field editable and chips removable; letters edited line by line; builder diffs; interview answers that can be corrected before sending | Nothing the AI writes is final, so people trust it | OBSERVED (profile); INFERRED (rest) | [cand]; [newjob-js] [capp-js] [builder-js] |
| 6 | Chat beside the thing it changes (C6) | Builder chat beside the live post; profile chat beside the record; "Ask the agent" on every section; Ask AI as a side panel over the board; workspace chat above the tool grid | Each answer's effect is visible at once, and editing by hand is one step away | OBSERVED | [demo] [cand] |
| 7 | List, then drawer, then board, without losing your place (C7) | A row opens a right-side drawer (Esc closes; Shift+J/K moves on); "Screen the pool" opens a separate board and returns; after a move, the list jumps to that stage | The list is always underneath; fewer page loads | OBSERVED (demo); INFERRED (keys) | [demo]; [jobhub-js] |
| 8 | Every suggestion says why and what next (C8) | Card headline, two strengths, one gap, a next action with its reason; the pool read and next steps; points lost per requirement; the candidate's "Why this is on your board" | The decision is half made when you arrive | OBSERVED | [demo] [cand] |
| 9 | Evidence beside the number (C9) | The transcript is one tab from the score; Ask AI shows what it looked at; "Not evidenced yet"; the posting's own words quoted. The exception: profile claims show no sources. | Checking does not mean hunting | OBSERVED | [demo] [cand] [profiles] |
| 10 | Everything pre-ticked, with one place to say "not this one" | Review & apply starts with every row ticked; untick to hold back; a live count; one button | Agreeing takes one click; disagreeing takes one more | OBSERVED (demo) | [demo] |
| 11 | Private by default, and said every time (C11) | "Private — the candidate wasn't notified." on every move; each Review & apply group says private, no email; private criteria and "Only you" requirements; no screening questions or criteria on the public page | Removes the fear of telling a candidate by accident | OBSERVED; INFERRED | [demo] [job-pattern]; [rubric-js] |
| 12 | Plain, gentle words for candidates | Candidate statuses Applied, Interview, Scored, Recruiter review, then Shortlisted or "Outcome" ("The recruiter has reviewed your application."); four plain promises on the apply card | Candidates never see internal stages | OBSERVED (apply card); INFERRED (statuses) | [job-pattern]; [capp-js] |
| 13 | Never ask twice (C12) | Saved answers; "Only This Once"; the profile answers employer questions; job description and website pre-fill; company defaults pre-fill new jobs; Job Match pulls in a Kanvis job's text | Every action after the first is much faster | OBSERVED; INFERRED | [cand]; [cbuild-js] [onb-js] [settings-js] |
| 14 | Keep my place (C13) | The quick-start draft kept in the browser; "Your spot for <role> is saved"; interviews resume with the transcript; the builder chat persists; opt-in assistant memory; frozen applications | Leaving is safe | OBSERVED; INFERRED | [cand]; [newjob-js] [cbuild-js] [cws-js] |
| 15 | Every failure falls back to doing it yourself (C10) | Reading errors fall back to typing; calm error lines ("Your account is fine.", "Nothing you were working on is affected."); skeleton loaders; progress text in stages; empty states with one action | AI trouble never leaves a person stuck | INFERRED (errors); OBSERVED (loading, empty states) | [newjob-js] [onb-js] [ws-js]; [cand] |
| 16 | Honest about weak matches | "Then we lowered the match bar"; "Then we stopped filtering … ranked by similarity, not scored"; "That's every open role we have" | People trust a ranking that admits its limits | OBSERVED | [cand] |
| 17 | Show the AI working | "Thinking it through…", "Writing the description…", "Reading your job description…", the "Setting up your interview" steps | Waiting feels shorter and less mysterious | OBSERVED (demo); INFERRED | [demo]; [newjob-js] [apply-js] |
| 18 | A small structure | Two roles; four sidebar places; one settings page that saves as you type; no approvals; no stage editor | Fewer choices and fewer screens | INFERRED (absence) | [sidebar-js] [settings-js]; [sweep] |
| 19 | A fixed record at sending | The application is frozen; a score already seen never moves | Nobody argues about a moving number | INFERRED | [terms] §5B; [recruiter] |
| 20 | Suggest, then the person saves | Rubric checks and scorer proposals change nothing until saved; Regenerate keeps applied decisions | The AI cannot quietly change the setup | INFERRED | [rubric-js] [decisions-js] |
| 21 | Counts everywhere | Stage pills with counts; "N to review", "N new"; "6 applicants · closes in 3w"; the Review & apply count | Status at a glance, without reports | OBSERVED (demo); INFERRED | [demo]; [jobslist-js] |
| 22 | Keyboard shortcuts | N or Shift+N for a new job; Shift+J and Shift+K for the next and previous applicant; Enter moves to the next quick-start step; Esc closes drawers and windows | Speed for daily users | OBSERVED (Esc); INFERRED (rest) | [demo]; [jobslist-js] [jobhub-js] [newjob-js] |

### 6.2 Why Kanvis's flows feel simpler

1. **Fewer decisions per screen.** One question, one card, one step at a time, with a visible count (patterns 1 to 3).
2. **The machine does the first draft of everything.** The job description, website and CV are read before anyone types. People check and correct instead of filling in forms (patterns 4, 5 and 13).
3. **The next step is always proposed.** Every card has a reason and a suggested next action, and the whole pool can be settled in one pass by unticking exceptions (patterns 8 and 10).
4. **It says what did not happen.** "Private", "nobody emailed" and "the candidate wasn't notified" appear on every action, so people act without worrying (pattern 11).
5. **The product is small.** Two roles, four sidebar places, one settings page, ten stages and no approvals, scheduling or integrations (pattern 18). Some of the simplicity comes from leaving things out (6.3).
6. **Failures are quiet.** Every AI step has a manual fallback and a calm message (pattern 15).
7. **Honesty builds trust.** Weak matches are labelled as weak, confidence is shown separately from the score, and "Too close to call" is used rather than inventing a difference (pattern 16; section 4.6).

### 6.3 What the simplicity costs

| Trade-off | Detail | Label | Evidence |
|---|---|---|---|
| No approvals, two roles | Every seat holder sees every applicant and, as far as we know, can publish and decide. There is no hiring-manager, HR or interviewer view. | INFERRED (absence) | [sweep]; [r-terms] §2 |
| No interview scheduling | After "Shortlist", interviews are arranged outside Kanvis. | INFERRED (absence) | [sweep] |
| No offer record | "Job Offer" and "Hired" are only stages. | INFERRED (absence) | [jobhub-js]; [sweep] |
| Stage moves without friction | One click, no reason asked in the demo (optional in the product), and "Hired" cannot be undone in the demo. | OBSERVED (demo); INFERRED | [demo]; [appdetail-js] |
| Closed jobs look open | A closed job stays on the public board and in "More roles on Kanvis" with no marker. | OBSERVED | [jobs] |
| Evidence promised, not shown | Profiles promise a source for every entry; none is shown. | OBSERVED | [profiles] [cand]; [llms] |
| "Private" against "always told" | The hiring side says nobody is emailed; the candidate side says decisions always reach them. The trigger is not shown anywhere. | OBSERVED (wordings); UNKNOWN (trigger) | [demo]; [cand] |
| Mixed promises on interview length | 5 to 10 minutes, about 10, or 15 to 20 in one employer's text | OBSERVED; OBSERVED-EARLIER (the 15 to 20) | [job-pattern] [recruiter]; [job-uplift] (7 Oct) |
| Demo and product disagree | The demo lists screening questions on the posting and announces to LinkedIn; real pages show no screening questions, and the code only copies the text and opens LinkedIn. The demo says Longlist and Pass; the legal text and marketing say Backup and Reject. | OBSERVED; INFERRED | [demo] [job-pattern] [recruiter]; [jobslist-js] |
| Closed sign-up | Hiring teams cannot start on their own; every plan goes through a waitlist. | OBSERVED | [waitlist] [pricing-r] |
| Browser-only memory | The quick-start draft and the pool-chat history live in one browser, so they do not follow a person to another device. | INFERRED | [newjob-js] [reviewer-js] |

---

## 7. Feature checklists A, B and C

**How the labels were merged.** On 14 October two passes ran: a public pass (no browser) and a browser pass (the demo and the founder's candidate account). Where the public pass could only read code (INFERRED) but the browser pass saw the thing on screen, the item is OBSERVED. Where the label differs between the demo and the real product, both are given. Where the 14 Oct findings disagree with the 7 Oct catalogue, or the two 14 Oct passes disagree, the Finding column starts with **Disagreement:**.

### 7.1 A. Candidate features

| # | Item | Label | Finding | Evidence |
|---|---|---|---|---|
| A1 | Conversational onboarding and profile creation | OBSERVED-EARLIER (building); OBSERVED (later state) | A two-pane builder: chat on the left, the live record on the right, with "ask the agent" on each section. On 14 Oct /candidate/build redirects an onboarded user to the workspace, and Edit portfolio keeps the same chat thread beside the record. | [cand]; [cbuild-js]; [people] (says every profile was built through a conversation) |
| A2 | CV upload and structured extraction | OBSERVED-EARLIER (upload); OBSERVED (result) | A PDF or DOCX drop zone; about 30 seconds of "Organizing skills & projects". The result on 14 Oct: 12 typed sections with counts. A guard against using a CV that belongs to another account. | [cand]; [cbuild-js]; [jobs] ("Upload Resume") |
| A3 | AI-assisted profile building and follow-up questions | OBSERVED (follow-up, "Ask the agent"); OBSERVED-EARLIER (action plan); INFERRED (action-plan states, confirm buttons) | One CV-grounded follow-up per turn; "Ask the agent to improve …" on every section; an action plan whose items move through Active, Pending, Completed and Skipped; AI entries confirmed with "Add to my record" or "Edit the wording" | [cand]; [cbuild-js] |
| A4 | Experience, skills, education, projects, certifications, achievements | OBSERVED | Work entry: Role*, Company*, Location, Type (8 kinds), dates, Summary, What you did, Results, Metrics, Skills used. Projects have a type and link; education has a GPA. Also Awards, Certifications (credential ID, verification link in code), Q&A, How you work, Links, What drives the work, Social impact, Activities. Public tabs: Overview, Experience, Skills, Projects, Education, Recognition, Approach. | [cand] [profiles]; [cbuild-js] |
| A5 | Evidence or source references behind profile claims | OBSERVED | Promised in llms.txt, on /what-is-kanvis and on /recruiter. Not shown anywhere, not even to the owner. **Disagreement:** the 7 Oct catalogue said the data's chat_source was null throughout; in fact some entries carry a numeric reference (6 of 36 and 18 of 48), with hidden proficiency and evidence fields. | [llms] [what-is]; [profiles] [cand] |
| A6 | Public profiles and visibility controls | OBSERVED | Public at /<username>, published automatically, no unpublish. The "Show in search" switch removes the profile from search, the sitemap and featured lists while the link keeps working (checked on 14 Oct; open on 7 Oct). A username change breaks the old link. "Hire me" goes to the hiring-team waitlist. Contradicts /what-is-kanvis, which says a profile stays private until the candidate chooses otherwise. | [cand]; [sitemap] [people]; [what-is] |
| A7 | AI Twin or profile chat assistant | OBSERVED (the box); INFERRED (behaviour); UNKNOWN (answers) | Box with 3 starter questions and an AI notice. The hiring team gets a Twin per application on every plan. The candidate is emailed when the Twin cannot answer. No message was sent. | [profiles] [cand]; [pricing-r]; [twin-js] |
| A8 | Job discovery, filtering and matching | OBSERVED | Public board: work mode, function, level, posted. Signed in: a tiered board (matched, then a lowered bar, then "stopped filtering"), search, For You or Recent, word exclusion, 8 filters with counts, Has salary, Saved. | [jobs]; [cand] |
| A9 | Job-fit scores, strengths, gaps and recommendations | OBSERVED (board); INFERRED (Job Match result) | A match ring on scored cards (for example 33). "Why this is on your board" shows skills matched (x of y), "Not evidenced yet" gaps, the level, and remote with a quote. Job Match: Strong, Partial, A stretch or Unlikely; align, fall short, learn; a dated action plan; PDF. **Disagreement:** the 7 Oct catalogue had "Why this is on your board" as INFERRED; it was seen on 14 Oct. | [cand]; [jdfit-js] [capp-js] |
| A10 | Tailored ATS résumé generation | OBSERVED (start screen); INFERRED (output) | One page, ATS-safe, STAR, from the verified profile; optional tailoring to a job description. Generation not run. **Disagreement:** the code names three templates; the screen offers four styles (Modern Compact, Executive, Tech Builder, Academic) with "match" badges. The screen wins. | [cand]; [cws-js] |
| A11 | Résumé editing, export and version history | OBSERVED (list, preview); INFERRED (editing) | A list of generated résumés with DEFAULT and STALE badges; PDF preview with Download; the default cannot be deleted. Code: drag to reorder, remove bullets, live preview, paged history. Several saved versions, not line-by-line history. | [cand]; [cws-js]; [api-js] |
| A12 | Cover letters and outreach | OBSERVED (start screens); INFERRED (output) | Cover letter: optional role or job description (500 characters); code adds line-by-line editing, "Make it more concise", PDF. Outreach: to whom (200), what to mention (500), tone; code adds regenerate, placeholders, copy and open LinkedIn or email. **Disagreement:** the screen's tones are Warm, Direct and Formal; the code's strings are "Friendly, personable", "Concise, professional" and "Traditional, careful" (probably their descriptions). | [cand]; [cws-js] |
| A13 | Conversational job applications | OBSERVED (promises); INFERRED (the flow) | The apply card promises a short conversational interview, no cover letter, about 5 to 10 minutes, and that the hiring team decides. Not started. **Disagreement:** the public pass labelled this OBSERVED from the promises; the browser pass labelled it INFERRED because nothing was run. Both are right about different things. | [job-pattern] [home]; [apply-js] |
| A14 | Application-specific follow-up questions | OBSERVED (demo sample); INFERRED (candidate side) | The demo's sample transcript shows the AI following up on the candidate's own words. In code, fixed rules choose each question from requirements, employer questions and profile gaps. **Disagreement:** labelled OBSERVED-EARLIER by the public pass and INFERRED by the browser pass; the candidate-side run was never seen. | [demo]; [r-terms] §3 |
| A15 | Candidate workspace and application tracking | OBSERVED (empty); INFERRED (with data) | Workspace home, Applications ("50 of 50 applications left this month"), Inbox, "My applications" on the board. Progress: Applied, Interview, Scored, Recruiter review, Shortlisted or Not selected. **Disagreement:** the 7 Oct catalogue called the 50 "inferred"; it is on screen. | [cand]; [capp-js] |

### 7.2 B. Recruiter (hiring-team) features

| # | Item | Label | Finding | Evidence |
|---|---|---|---|---|
| B1 | Conversational job creation | OBSERVED (demo film); INFERRED (product) | The demo starts with a one-line brief, then three chip questions one at a time, then the post is written live. The product starts with a 10-step tap quick start (optionally from a job description), then "Write the job post", then the conversational builder. **Disagreement:** the 7 Oct catalogue described the demo's chat box as the start; it exists only in the demo. | [demo]; [newjob-js]; [whats-new] 28 Sep |
| B2 | Job description writing and editing | OBSERVED (demo); INFERRED (product) | The demo's preview fills section by section; its Edit toggle and "Preview listing" do nothing. Product: "Ask the agent" per section, diffs and jump links, and editing one part does not rewrite the rest. | [demo]; [builder-js]; [whats-new] 23 Sep |
| B3 | Required qualifications and must-haves | OBSERVED (demo, public pages); INFERRED (quick start) | Demo: ticked answers become must-haves, the rest nice-to-haves. Public pages show Must have and Nice to have. Quick start: must-have skills ("Every applicant is checked against these."), dealbreakers, and a minimum-experience rule ("Rule them out"). | [demo] [job-pattern]; [newjob-js] |
| B4 | Private screening criteria | INFERRED | A "private criteria" box that the marketing page marks as never shown to candidates; "Only you" rubric requirements; a private note per screening question; the interviewer gets only neutral topics. Not in the demo. | [recruiter]; [rubric-js] [builder-js]; [r-terms] §7 |
| B5 | Structured rubrics and scoring rules | OBSERVED (display); INFERRED (editor) | The demo drawer shows weights, the must-have tooltip and points lost per requirement. Code: 3 to 12 requirements, kinds, weights, Must pass, Only you, re-scoring rules, an AI rubric checker. Marketing says every number is worked out from the interview record. The Rubric tab does nothing in the demo. | [demo]; [rubric-js]; [recruiter] |
| B6 | Public job pages and sharing | OBSERVED (page); INFERRED (share tools) | Branded and unbranded pages; job-posting data for Google; the closed state; "More roles on Kanvis". The demo's publish rows are plain text and its Share tab does nothing; share buttons, tracked links and the LinkedIn composer are in code. | [job-pattern] [job-clickfortify] [job-uplift]; [demo]; [jobslist-js] [jobhub-js] |
| B7 | Candidate discovery and bulk résumé import | INFERRED; OBSERVED (/people) | /people has city and skill pages and no search. "Hire me" goes to the waitlist. Import CVs: 50 per batch, shown as "Sourced". Kanvis's own comparison says it does no sourcing. | [people]; [jobhub-js]; [pricing-r] |
| B8 | Résumé parsing into structured records | INFERRED (hiring side); OBSERVED-EARLIER (candidate side) | CV import: Uploading, Parsing, Scoring. Job-description reading feeds the quick start; the website and documents are read in onboarding. | [jobhub-js] [newjob-js] [onb-js]; [cand] |
| B9 | AI screening interviews | OBSERVED (promises, demo sample); UNKNOWN (a real interview) | Job pages promise a short conversational interview; /recruiter says Kanvis interviews everyone who applies; the demo says "I interviewed each one" and shows a transcript. | [job-pattern] [recruiter]; [demo] |
| B10 | Follow-ups specific to each candidate | OBSERVED (demo sample) | Two AI follow-ups built on the candidate's answer in the demo's Interview tab. There is no questionnaire a recruiter can send after an application; the alternatives are "What to probe", the "Request info" next step and a personal email. | [demo]; [appdetail-js] [decisions-js] |
| B11 | Transcripts and evidence references | OBSERVED (transcript); INFERRED (per-claim links) | Screening answers and the conversation in the demo; "From the interview" markers in code. "Evidence links on every claim" is marketing only and does not appear in the demo. | [demo]; [appdetail-js]; [recruiter] |
| B12 | Explainable scores and confidence | OBSERVED | Radar, weights, "What it cost her" with share met and points lost, "Cost x points" tooltips, "AI is confident", "Needs your eye", "Too close to call" (code). | [demo]; [jobhub-js] |
| B13 | Ranked applicant lists | OBSERVED (demo); INFERRED (sort and search) | The demo list is ordered by score with colour bands and a "Match score NN / 100" tooltip. Code: sort by score, recent or stage; search; band and source filters; Tune ranking. | [demo]; [jobhub-js] |
| B14 | Shortlist, backup and reject recommendations | OBSERVED | Demo: Shortlist, Longlist and Pass, each with a reason and a next action. **Disagreement (unchanged since 7 Oct):** the /recruiter mock and the legal text say Shortlist, Backup and Reject. | [demo]; [recruiter]; [r-terms] §1 |
| B15 | Decision boards and shortlist review | OBSERVED (demo) | Board, then Review & apply: everyone pre-ticked, untick to hold back, a live count, "Done" chips, the button locks after use; Pass files to Disqualified, privately, with no email. Only Lena can be held back in the demo. | [demo] |
| B16 | Plain-language questions about a pool | OBSERVED (demo); INFERRED (product) | Demo Ask AI: suggested questions, chips showing what it looked at, answers labelled EXAMPLE; typed questions get the closest pre-written answer; it cannot move anyone. Product: four tools, a confirmation before any move, undo. **Disagreement:** the 7 Oct notes said the assistant "can move anyone"; the demo cannot. | [demo]; [reviewer-js] |
| B17 | An AI assistant for each candidate | INFERRED | "Ask <name>" Twin over the frozen profile; cannot change the status; "Per-application Twin" on every plan. Not in the demo. | [appdetail-js]; [pricing-r] |
| B18 | Private notes and pipeline stages | OBSERVED (stages); INFERRED (notes) | A 10-stage menu and the "Private — the candidate wasn't notified." toast. Notes in code: sticky notes with templates, team only. **Disagreement:** the 7 Oct catalogue said every move asks for a reason; the reason is optional in code, and the demo asks nothing. | [demo]; [appdetail-js]; [stages-js] |
| B19 | Application history and frozen records | INFERRED | "An application is fixed at the moment it is submitted"; a History tab (the last 200 recruiter actions, with reasons); on the candidate side, "Your snapshot is still on file". The demo's History tab does nothing. | [recruiter]; [appdetail-js] [capp-js] |
| B20 | Candidate emails with a person's approval | INFERRED | AI-drafted, edited and sent by the recruiter; bulk invite, offer or warm pass, previewed per person; nothing sends by itself. The demo's Email button does nothing (tooltip seen). The candidate's Settings promise that decisions always reach them (OBSERVED). | [r-terms] §6; [jobhub-js] [appdetail-js]; [demo]; [cand] |
| B21 | Team workspaces, members and permissions | INFERRED | Owner and Member only; invites with a locked email and a code; seats by plan (Free 1, Pro 1, Team 3 then $39 each, Scale the whole team). The demo shows "Acme Pay · Owner". No approvals. | [invite-js] [settings-js]; [pricing-r]; [demo]; [sweep] |
| B22 | Hiring for several roles at once | OBSERVED (several jobs); INFERRED (no role-based workflows) | The demo sidebar lists several jobs (live with a count, and a draft); plans are sized by open jobs. There are no hiring-manager or interviewer roles, approvals, panel scorecards or scheduling. **Disagreement:** labelled INFERRED by the public pass and OBSERVED by the browser pass; the several-jobs part was seen, the rest is absence in code. | [demo]; [jobslist-js]; [pricing-r]; [sweep] |
| B23 | Reporting, audit and decision history | INFERRED | Analytics tab, Compare report as a PDF, CSV export, History tab, recorded reasons. No company-wide audit log screen. The demo's Analytics and History tabs do nothing. | [jobhub-js] [appdetail-js]; [demo] |

### 7.3 C. Interaction design

Each item is explained in section 6.1 (the row number is given).

| # | Item | Label | Finding | Evidence |
|---|---|---|---|---|
| C1 | Conversation against long forms (6.1 #1) | OBSERVED (demo, tools); INFERRED (quick start) | Chat where judgement is needed; taps and steps for facts; short optional forms for tools. No long form visible. **Disagreement:** the public pass labelled it INFERRED; the browser pass saw it. | [demo] [cand]; [newjob-js] |
| C2 | Progressive disclosure (6.1 #3) | OBSERVED; INFERRED (quick-start follow-ups) | Drawers over lists; collapsed sections with counts; accordion filters; shortened card text; follow-ups only when needed; tools locked until onboarding ends. | [demo] [cand]; [newjob-js] |
| C3 | One question at a time (6.1 #2) | OBSERVED | The "1 OF 3" card; one follow-up per builder turn; "Step N of 10" (code); "Question 3 of 6" on the home page. | [demo] [cand] [home]; [newjob-js] |
| C4 | AI output that can be inspected and edited (6.1 #5) | OBSERVED (profile); INFERRED (rest) | Every AI-filled profile field editable; review step with Edit (code); letters edited line by line (code); builder diffs. The demo's Edit toggle for the post does nothing. | [cand]; [newjob-js] [cws-js] [builder-js]; [demo] |
| C5 | Automatic extraction against explicit confirmation (6.1 #4, #10) | OBSERVED; INFERRED | The CV is read and saved into the record at once; the job description and website are read and labelled for checking; board decisions need "Apply N decisions"; demo stage moves are instant, with no confirmation. | [cand]; [newjob-js] [onb-js]; [demo] |
| C6 | Moving between conversation and structured tools (6.1 #6) | OBSERVED | Workspace chat above the tool grid; chat beside the record; "Ask the agent" on every section; Ask AI beside the board. | [cand]; [demo] |
| C7 | List, record and decision-board navigation (6.1 #7) | OBSERVED (demo) | Row, then drawer (Esc closes); "Screen the pool" opens a separate board; board cards do not open records in the demo; after a move, the list jumps to that stage. | [demo]; [jobhub-js] |
| C8 | Explaining recommendations (6.1 #8) | OBSERVED | Card headline, strengths and gap, a next action with a reason, the pool read, points lost per requirement, the candidate's "Why this is on your board". | [demo]; [cand] |
| C9 | Showing evidence (6.1 #9) | OBSERVED | Transcript, Ask AI chips, "Not evidenced yet", the posting's own words quoted. Profile claims show no sources. | [demo] [cand] [profiles] |
| C10 | Loading, retry, error and unfinished states (6.1 #15) | OBSERVED (loading, empty, closed job); INFERRED (errors) | "Loading your settings…", empty states, the STALE badge, refresh buttons, demo progress ticks; in code: skeletons, the panel error screen, "Couldn't reach Kanvis", the AI error lines, manual fallbacks, invite-link states, "Pick up where you left off". | [cand] [job-uplift]; [ws-js] [newjob-js] [invite-js] |
| C11 | Keeping private hiring-team information apart from what candidates see (6.1 #11) | OBSERVED; INFERRED | Private toasts and Review & apply wording; no screening questions or criteria on the public page; identity details stored apart and sent only when a form asks; "Only you" requirements; the candidate sees only simple statuses and a candidate-safe score. | [demo] [job-pattern] [cand]; [rubric-js] [capp-js] |
| C12 | Reducing repeated data entry (6.1 #13) | OBSERVED; INFERRED | Job Match pulls in a Kanvis job's text; saved answers and identity details reused; résumé, letter and outreach built from the profile; "Apply with your profile"; "Only This Once"; website and job-description pre-fill. | [cand]; [cbuild-js] [onb-js] [newjob-js] |
| C13 | Keeping context across a workflow (6.1 #14) | OBSERVED; INFERRED | The builder chat persists beside the record; the Ask AI thread grows; assistant memories exist; the quick-start draft is kept in the browser; interviews resume. The demo keeps state within a chapter but resets between chapters. | [cand] [demo]; [newjob-js] [cws-js] |

---

## 8. Route and screen inventory

**In plain words.** These are the web addresses Kanvis uses and what each one shows. Hiring-team and candidate pages return an empty frame to anyone (HTTP 200); the sign-in check then runs inside the browser. No route was added or removed between 7 and 14 October, because nothing was shipped.

### 8.1 Hiring-team (recruiter) routes

| Route | Screen | Frame | Label | Evidence |
|---|---|---|---|---|
| /recruiter | Hiring-team landing page | public | OBSERVED | [recruiter] |
| /recruiter/demo | Interactive demo (5 chapters) | public | OBSERVED | [demo] |
| /recruiter/waitlist?plan=<plan> or ?candidate=<username> | Early-access form | public | OBSERVED | [waitlist] [pricing-r] [profiles] |
| /recruiter/accept-invite | Accept a teammate invite | full screen, outside the workspace | OBSERVED (frame); INFERRED (screen) | [shells]; [invite-js] |
| /recruiter/onboarding | Company onboarding (owners) | full screen | OBSERVED (frame); INFERRED (screen) | [shells]; [onb-js] |
| /recruiter/dashboard | Dashboard, "Inbox · <date>" | workspace | OBSERVED (frame); INFERRED (screen) | [shells]; [dashboard-js] |
| /recruiter/jobs | Jobs list (page title "Jobs \| Kanvis") | workspace | OBSERVED (frame, 14 Oct); INFERRED (screen) | [shells]; [jobslist-js] |
| /recruiter/jobs/new | Redirects (307) to /recruiter/new-job | n/a | OBSERVED | [requests] |
| /recruiter/new-job | New-job quick start, 10 steps (page title "New job \| Kanvis") | full screen | OBSERVED (frame); INFERRED (screen) | [shells]; [newjob-js] |
| /recruiter/new-job/[id] | Conversational Job Builder | full screen | OBSERVED-EARLIER (frame); INFERRED (screen) | [shells]; [builder-js] |
| /recruiter/jobs/[id] | Job hub. ?view=applicants (default), compare, rubric (tab label "Scoring"), analytics, share, manage (tab label "Details"); &stage= and &band= filters; ?applicant=<id> opens the drawer; &duel=<id> for head to head; ?section=overview, visits, dropoff or applicants for analytics | workspace | OBSERVED-EARLIER (frame); INFERRED (parameters) | [shells]; [jobhub-js] [appdetail-js] |
| /recruiter/jobs/[id]/edit | Redirects (307) to /recruiter/new-job/[id] | n/a | OBSERVED-EARLIER | [shells] |
| /recruiter/jobs/[id]/decisions | Decision board | workspace | OBSERVED-EARLIER (frame); OBSERVED (demo address) | [shells]; [demo] |
| /recruiter/jobs/[id]/applications/[appId] | Full-screen application | workspace | INFERRED | [jobhub-js] [appdetail-js] [decisions-js] |
| /recruiter/settings with #company, #job-page, #library, #team, #notifications, #personal, #account, #workspace | Settings, one page | workspace | OBSERVED-EARLIER (frame); INFERRED (sections) | [shells]; [settings-js] |
| /no-access | Where a visitor with no valid sign-in lands | n/a | INFERRED | [guards-js] |

The demo's fake address bar runs kanvis.me/recruiter/jobs/new, then /recruiter/jobs/a41c8e/edit, /recruiter/jobs/a41c8e, /recruiter/jobs/a41c8e/decisions and back. In the real product, /jobs/new and /edit both redirect to /new-job. *(OBSERVED; [demo]; [requests])*

### 8.2 Candidate routes

| Route | Screen | Label | Evidence |
|---|---|---|---|
| /candidate, /candidate/continue | Entry points that redirect | INFERRED | [candroutes-js] |
| /candidate/upload?apply_to=<job> | CV upload | OBSERVED-EARLIER (frame) | [upload-js] |
| /candidate/build (?action=parse&apply_to=<job>) | Profile builder; redirects to the workspace once onboarded | OBSERVED | [cand]; [shells] |
| /candidate/publish (?change=1 to change the username) | Choose a username and publish | OBSERVED-EARLIER; INFERRED (?change=1) | [cand]; [cws-js] |
| /candidate/apply?apply_to=<job> | Rewritten to /jobs/<id>?apply=1 once the profile is published | INFERRED | [guards-js] |
| /candidate/checklist | Onboarding checklist | INFERRED | [guards-js] |
| /candidate/applications/[id]?focus=interview | Interview and application page | INFERRED | [apply-js] [capp-js] |
| /candidate/workspace?tool=<tool> | Workspace. Seen in the address bar on 14 Oct: browse_jobs, my_applications, inbox, edit_profile, resume, jd_analysis, email, cover_letter. The code also lists resume_history, resume_templates, jd_analyses, email_history and cover_letter_history (list pages, probably). | OBSERVED; INFERRED | [cand]; [cws-js] |
| /auth, /onboarding | Sign-in and onboarding entry | INFERRED | [candroutes-js] |

### 8.3 Public routes

| Route | Screen | Label | Evidence |
|---|---|---|---|
| / | Home (candidate pitch) | OBSERVED | [home] |
| /jobs | Public job board; a signed-in candidate is redirected to the workspace board | OBSERVED | [jobs] [cand] |
| /jobs/<22-character id> (?apply=1, ?src= or ?r=, ?source_invite=) | Public job page and apply entry | OBSERVED (page); INFERRED (parameters) | [job-pattern]; [apply-js] |
| /jobs/at/<company> | Company careers page | OBSERVED-EARLIER | [careers] |
| /people, /people/in/<city> (lahore, islamabad, karachi), /people/skills/<skill> (about 37) | People directory | OBSERVED | [people] |
| /<username>, /<username>/opengraph-image | Public profile and its share card | OBSERVED | [profiles] |
| /pricing, /pricing/recruiters, /pricing/candidates | Pricing | OBSERVED (first two) | [pricing-r] |
| /about, /what-is-kanvis, /whats-new, /press, /compare and /compare/resume, /compare/linkedin, /compare/portfolio-website | Marketing | OBSERVED (what-is, whats-new); OBSERVED-EARLIER (rest) | [what-is] [whats-new] |
| /legal/privacy, /legal/terms, /legal/recruiter-terms, /legal/dpa | Legal | OBSERVED-EARLIER | [privacy] [terms] [r-terms] [dpa] |
| /sitemap.xml, /robots.txt, /llms.txt | Site files | OBSERVED | [sitemap] [robots] [llms] |

### 8.4 Who gets sent where (route guards)

| Who | Opens | Result | Label | Evidence |
|---|---|---|---|---|
| Anyone not signed in | A hiring-team or candidate page | The empty frame loads (HTTP 200); the browser then sends them to sign-in, remembering where they were going | OBSERVED (200); INFERRED (redirect) | [shells]; [guards-js] |
| A signed-in candidate | /recruiter/dashboard | /candidate/workspace | OBSERVED | [cand] |
| A signed-in candidate | /jobs | /candidate/workspace?tool=browse_jobs | OBSERVED | [cand] |
| An onboarded candidate | /candidate/build | /candidate/workspace | OBSERVED | [cand] |
| A hiring-team seat | A candidate page | /recruiter/dashboard | INFERRED | [guards-js] |
| An owner whose company is not set up | Any hiring-team page except settings | /recruiter/onboarding | INFERRED | [guards-js] |
| A member (not owner) | /recruiter/onboarding | /recruiter/dashboard | INFERRED | [guards-js] |
| Anyone in a suspended company | Any hiring-team page | "Your workspace is suspended"; settings read-only | INFERRED | [guards-js] [ws-js] |
| No valid sign-in at all | n/a | /no-access | INFERRED | [guards-js] |

### 8.5 The 14 October route diff

| Route | 7 Oct status | 14 Oct finding | Label | Evidence |
|---|---|---|---|---|
| /recruiter/jobs/new | 307, target not captured | 307 to /recruiter/new-job | OBSERVED | [requests] |
| /recruiter/jobs | Linked only; frame not fetched | Frame 200, inside the workspace layout | OBSERVED | [shells] |
| /recruiter/new-job | Linked only | Frame 200, full screen (outside the workspace layout); loads the quick-start code | OBSERVED; INFERRED | [shells]; [newjob-js] |
| /candidate/workspace | Code strings only | Frame 200; the tool list read in code | OBSERVED; INFERRED | [shells]; [cws-js] |
| /candidate/build | Seen live | Frame 200 ("Build Portfolio") | OBSERVED | [shells] |
| /candidate/publish?change=1 | Not listed | The change-username entry, linked from the workspace | INFERRED | [cws-js] |
| Sitemap | 454 addresses | 492: 38 new profiles, 2 new jobs, 2 removed; 17 job pages; no new kinds of page | OBSERVED | [sitemap] |
| robots.txt Disallow list | /candidate/, /recruiter/dashboard, /recruiter/jobs, /recruiter/settings, /recruiter/onboarding, /recruiter/accept-invite, /no-access, /icons, /api/, /ingest/ | identical | OBSERVED | [robots] |
| API paths not listed before | n/a | /api/recruiter/jobs/intake-from-jd/ and /api/recruiter/jobs/parse-jd-document/ (quick start); /api/recruiter/invites/verify-code/ (invites); /api/resume/history/; /api/resume/star/recompile/; /api/profile/<username>/resume/. None was called. | INFERRED | [newjob-js] [invite-js] [api-js] |

### 8.6 Server addresses named in the code (read only; none was called)

*(INFERRED; [api-js] [authapi-js] [newjob-js] [invite-js])*

| Area | Paths (each under /api/) |
|---|---|
| Sign-in | auth/send-code, auth/verify-code, auth/google, auth/adopt-draft |
| Jobs | recruiter/jobs/{id}/ with publish, pause, resume, close, brief (apply, revise_post), setup (thread, answer, route), rubric (chat, generate, update), rubric-medians, rerank, rescore-all, decisions (generate, commit), analytics/{view}, share-links, linkedin-post (draft, save), comms/bulk-send, pipeline/bulk, import-cvs (upload-url, items, finalize, bulk-apply-invite and its preview, resolve-duplicate, send-apply-invite, download-url), publish-feedback; recruiter/jobs/intake-from-jd, parse-jd-document |
| Applications | recruiter/applications/{id}/ with stage, pipeline, rescore, resume-url, comms (draft, preview, send), twin/message |
| Company and team | recruiter/applicants (recent, stats), recruiter/team, recruiter/invites (verify, verify-code), recruiter/organization (upload-logo, upload-cover), recruiter/documents, recruiter/onboarding (read-website, deduce, skip), recruiter/me, jd-mentor |
| Candidate applying | applications/fit-check, direct-apply, {id}/answers, attachments (upload-url, finalize), review, submit; interview/voice (session, transcript, dropped); messages (read, reply, unread-count) |
| Candidate profile and tools | candidate/ (initialize, me, update-profile, manual-entry, onboarding-answers, onboarding-checklist, profile-suggestions, answer-suggestions, visibility, email-preferences, cookie-consent, pending-apply-target, cover-letter/generate, share-template/generate, upload-profile-image); resume (upload, history, star/generate, star/recompile, star/templates); username (check, claim, suggestions, auto-publish); board (feed, filters, preferences); chat (sessions, transcribe, attachments); profile/<username>/resume |

Reserved usernames in the code include accept-invite, decisions, applications, dashboard, settings, billing, enterprise, discover, features and search. Some of these may be planned pages, but nothing confirms it. *(INFERRED; [reserved-js])*

---

## 9. Open questions that still need an account or an application

**In plain words.** Everything below needs either a hiring-team seat on Kanvis or an application as a candidate. None of it is a decision for the founder: the "What it would tell us" column says which already-built part of our product each answer would be a reference for. None of it needs the REA toolkit.

### 9.1 Needs a hiring-team (recruiter) seat

| # | What we still do not know | What it would tell us | Earlier ref |
|---|---|---|---|
| R1 | What happens after the waitlist form: a confirmation, a call, how long until access, whether Kanvis sets up the first job | How much hand-holding Kanvis needs to get a company started; a reference next to our open sign-up with a one-time ITS check (B7, built) | K1 |
| R2 | The real quick start and its hand-off to the conversational builder: how many follow-up questions, whether there is a second round, whether "Why this matters" opens, what Attach documents and the microphone do | A wording and step-count reference for our drafting space (Q4, Q5, Q8, built) | K2, K3 |
| R3 | Where the builder's proposed pay range comes from, and whether it warns about low pay | Whether Kanvis uses market data at all; we always show pay (Q9) | K4 |
| R4 | The post editor (Preview and Edit) and the Scoring tab: sliders, Must pass, Only you, the rubric checker's warnings, what a re-score looks like | A layout reference for editing must-haves and weights | K5, K6 |
| R5 | The exact score formula, how a failed must-have "sinks" someone, and when "Too close to call" appears | A wording reference only; our formula is fixed in code (`docs/spec/22-match-score-and-pool-board.md` §1) | K11 |
| R6 | The board on a real pool: time and cost to generate; whether a card can change column; whether a next-action tag opens an email; Regenerate after applying; undo | A reference for our pool board and Review and apply (B4, built) | K12 |
| R7 | Review & apply with several people held back, changing someone's group, applying a held-back person later, and what a Free company sees without pipeline stages | Edge-case reference for our Review and apply | K13 |
| R8 | The drawer's Compare, Profile, Résumé, Notes and History tabs, and the applicant Twin | A reference for our candidate panel (Q23) and team notes (Q24) | K14 |
| R9 | The real stage-move dialog: the optional reason, the "also send…" follow-up, whether "Hired" asks anything, undo | A reference for our stage button (B3) | K15 |
| R10 | What the AI-drafted invite, offer, warm pass and rejection say; branding, sender, where replies go; whether an invite carries times or a booking link | A wording reference for our decision and invitation messages (Q28) | K16, K17 |
| R11 | Whether any offer record exists beyond the "Job Offer" stage | Confirms the absence next to our record-only "Offer made" (Q29) | K18 |
| R12 | Which hiring-team action makes the candidate see "Shortlisted" or "Not selected", and when Kanvis's decision email goes. This needs a candidate account too. | Settles Kanvis's "private" against "decisions always reach you"; a reference for B6 | K19 |
| R13 | The dashboard, jobs list, settings, team, Company library, CV import and hiring-crew panel in use | Layout and wording reference | K20 to K23 |
| R14 | How plan limits, the 20% allowance and the trial show in the product; whether billing screens exist | A reference for how we show allowances (Q17, Q33) | K25 |
| R15 | The real Ask AI: its tools, the confirmation before a move, undo, where its history is kept | Input for the free-text "ask about the pool" chat, already scheduled for later (B5) | B16 |
| R16 | LinkedIn: does anything post without the recruiter; which plan has it; the later "applicants from LinkedIn" figure | A reference for the LinkedIn announcement in our backlog | K8 |
| R17 | Whether a public job page ever lists the screening questions | A reference for our job page | K9 |
| R18 | The hiring-team product on a phone (375 pixels wide) | Mobile reference. The demo part can be checked without an account. | K24 |

("Earlier ref" points to the 7 October gap list; "B16" is the checklist item in 7.2.)

### 9.2 Needs an application or AI generation on the candidate side

| # | What we still do not know | What it would tell us | What it needs |
|---|---|---|---|
| P1 | The apply window when signed out | How Kanvis asks a stranger to sign in at the moment of applying | The founder signs out of her own account and looks; nothing is sent |
| P2 | The preparation screen; how many questions and follow-ups; the real length; how employer questions are woven in; the "Suggested from your profile" label; declining a question; voice or text; equal-opportunity questions | A reference for our screening conversation in the same visit (B1, built) | An application |
| P3 | The review screen and sending; what "frozen" looks like to the candidate | A reference for our review-before-send (the 9 Oct follow-up) | An application |
| P4 | After sending: the fit score the candidate sees, the decision tab, which emails arrive and when (received, fit report, job closed, the 45-day notice), the two-way Inbox | A reference for our status page and messages (Q14, B6, Q27) | An application, then a hiring-team action |
| P5 | The output of Job Match, the résumé, the cover letter, outreach and the workspace chat | The quality bar for candidate tools | AI generation in her own account; no application |
| P6 | Twin answers: sources, refusals, the "couldn't answer" email | How a profile chat handles questions it cannot answer | One message to the twin on her own profile |
| P7 | Why the signed-in board shows 7 of 17 jobs | How Kanvis's job-matching settings filter the board | Reading her Job matching settings (no change) |
| P8 | How to withdraw an application, and what remains afterwards | A reference for leaving the process | An application |

### 9.3 How the answers could be got safely

- **A hiring-team seat** needs the founder to send the waitlist form herself. It shares her name, company, email and phone with Kanvis. She would need a different email from her candidate account, because one sign-in cannot be both.
- **The Team plan matters.** Pipeline stages, candidate emails and analytics are Team plan and up, so the seat would need the 30-day Team trial that Kanvis promises.
- **Prefer her own test job.** The cleanest way to watch the candidate side is to apply to a test job the founder posts with that seat. Applying to a real company's job sends a real application and uses that employer's allowance. Do it only if the founder chooses the job and says yes.
- **One yes per action.** Every account, form, application, AI generation or Twin message is done by the founder, or with her explicit yes for that one action.
- **No REA needed.** The REA toolkit is not needed for any of these (section 2.5).

### 9.4 Recorded decisions this comparison touches (no new decisions)

Two pairs of recorded decisions could look contradictory side by side. Both were settled when they were made; they are listed only so nobody reads them as open.

- **B6 and Q27.** B6 keeps decisions private until a person tells the candidate. Q27 keeps a safety net: a reminder after 2 business days, and the standard message after 5. The plan kept both: the safety net stays, and the Review and apply group line says so (`docs/spec/22-match-score-and-pool-board.md` §5). Several other screens still say nothing is sent (known bug 19), so how the two fit together on screen, and for batch and role-closing decisions, is asked as follow-up D-03 in `docs/workflow-decisions.md`; that follow-up reopens neither decision. For comparison, Kanvis's hiring side never sends a decision by itself; Kanvis instead sends its own "no decision yet" notice after 45 days (INFERRED).
- **B6 and Q25's 9 October follow-up.** Cancelling a booked interview tells the candidate at once, without a reason, that the interview is off. This is a deliberate exception recorded on 9 October, and it is built that way.
