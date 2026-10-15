# Workflow decisions register (Phase Four)

Created 14 October 2026 on branch `kanvis-reaudit` (the same code as `origin/main` dafb730). Brought up to date on 15 October 2026 after Waves S1 to S8 (`main` c990949 plus PR #45, which is in review).

This page lists every product decision: what was chosen, who chose it, when, and where it is built, so nothing is asked twice. The decisions still open are in one short table, **Still to decide**, just below the dated sections. Section 2 keeps the batch 1 questions as they were asked on 14 October (what Recruiting OS did then, what Kanvis (kanvis.me) does, what changes for each person, and what we recommended). The engineering evidence (file paths, routes, feature ids) sits in tables and "Evidence" columns so the team can act on any answer.

**Where the facts come from**
- The verified product audit in `docs/audit/`. Its nine area files (01 to 09) were each checked by a second, skeptical reader. Feature ids such as APPLY-50 come from `docs/audit/feature-inventory.md` and bug numbers from `docs/audit/known-bugs.md`.
- The Kanvis research of 7, 14 and 15 October 2026 (working notes kept outside the repository).
- The merged pull requests #39 and #42 to #44 (Waves S1 to S7) and PR #45 (Wave S8, in review), and their specifications (kept outside the repository).
- `docs/FOUNDER-CONTEXT.md`, `docs/01-product-thesis.md`, `docs/spec/22-match-score-and-pool-board.md` and `docs/spec/11-counsel-register.md`.

Every statement about Recruiting OS in batch 1 was checked again against the code on 14 October 2026. Nothing has been tried with real candidates yet. The latest real-model fairness run (15 October, after Wave S7, run 38717936154, about $0.42) passed all 11 résumé-reading and scoring suites it ran. The run after Wave S5 had failed two bias pairs; Wave S7 fixed that. The screening-chat tests have run only on the stand-in AI so far. The automated tests run on stand-in providers: after Wave S8, 2,849 passed, 6 skipped, 0 failed (2,148 passed on 14 October).

## 14 October 2026: founder delegated

The founder said the documents were too much to review, and asked Claude to decide: keep the app basic, with a Kanvis-like flow for the employer and for candidates, on the current tech stack, with nothing extra added. Claude decided batch 1 on that basis on 14 October (the founder revised D-01 on 15 October):

| Id | Decision | What it means | Where it is built |
|---|---|---|---|
| D-01 | **A**, revised by the founder on 15 Oct | No candidate accounts. Candidates keep the private emailed link, one application per role and the status page. Revised on 15 October after the founder watched Kanvis's application: a Kanvis-like record built from the candidate's résumé and sent chats, kept per company only (no account across companies, no public profile, no AI twin), and the reuse of earlier details at the same company after an emailed link. Kanvis's accounts, public profiles, twin and candidate tools are not adopted, and C's ITS-wide jobs page is not built. | Wave S7 (PR #44, merged). Earlier chat facts kept on the next application: Wave S8 (PR #45, in review, merging 15 Oct). |
| D-02 | **Not now** | Keep the app basic: no manual add or import of people who did not apply yet. Referrals keep using the job link or the email-in address. Can be asked again later. | Nothing to build |
| D-03 | **A** | Keep the day-5 standard message (Q27 A as built). Every screen that says a decision is private also says, in one short line, that the standard message goes by itself after 5 working days if nobody sends one, with the date when it is known. | Wave S1 (PR #39). The day-5 message itself was built earlier (PR #26). |
| D-04 | **C** | Hide earlier applications and their outcomes, and the name, email, phone, street address, zip code and web links, from the AI's scoring readings; then re-run the fairness tests with a pair that differs only in an earlier rejection. The team still sees everything. Done: the fairness tests and the earlier-rejection pair were added in Wave S3. The real-model run after S1 to S4 passed bias pairs 4/4 and redaction 2/2. After S5 a run found the score could drop when more evidence was shown (two bias pairs failed); S7 fixed it, and the run after S7 passed all 11 résumé-reading and scoring suites. Wave S8 keeps the rule. | Waves S2 and S3 (PR #39) |
| D-05 | **Not now** | Keep the labels only ("read against version N"); nothing re-reads. Can be asked again later. | Nothing to build |

**Wave S1 (simple screens), built the same day** on branch `kanvis-simple` (PR #39, merged 15 Oct as 63d371e; Waves S2 to S4 went in the same PR). No capability was removed; details moved one click away (a tab, a More menu or a "Show more" block):
- The menu reads Home, Jobs, Candidates, Interviews, Settings.
- Home: a greeting, one line, "Needs you" (up to 5 short rows, each with its "Why"), "Your jobs", the "Who are you hiring?" box and the recent activity folded.
- Jobs: one row per job; a live job opens on its Candidates. Each job has one header and one tab strip: Candidates, Job, Scoring, Interview plan, Share, Report, Activity, with the rarer actions in its More menu.
- The candidate panel: the verdict, the next step, strengths and concerns first; the full breakdown one click away.
- Settings: five tabs (Company, Team, Notifications, Hiring rules, Security). Old links still land on the right card.
- Candidate pages: shorter first views; every legal text is still on the page, folded under "How AI is used" or "Read the full notice".

## 15 October 2026: founder delegated (Wave S5, "complete my product")

The founder said "yes complete my product, do what you have to do". Claude decided these on the same basis (basic, Kanvis-like, current stack, nothing extra). The ones marked "as recommended", the licence rule and the accepted behaviour were built in Wave S5 on branch `complete-product` (PR #42, merged 15 Oct as 013837e); the "not now" ones are not built:

| Id | Decision | What it means |
|---|---|---|
| L-01 | **As recommended** | Wording the fairness check flagged, kept on a live (or paused) job, needs a second approver's yes before it goes public. The person who kept it cannot approve it, unless they are the company's only owner, or nobody else could decide. The job's named decision maker is told when someone else's wording-only edit goes live; it is not blocked. |
| L-10 | **As recommended** | "Leave this company" for any member, from their own row in Settings > Team; an owner only while another owner remains. Closing a whole company stays a request to ITS. |
| L-12 | **As recommended** | After our own interviewer misses an interview, the candidate's card offers "Approve the same round again" first and the new invitation opens with an apology. The owner can still pick another round. |
| Licence readings | **New rule** | A licence, certificate, permit or registration must-have is "no" only when the candidate's own words say plainly they do not hold it. Lapsed, expired, pending, in training or unclear is "unknown" (asked about in the screening chat), never "no". The code enforces it after the model answers, for the résumé reading and the screening scorecard, so the same CV always gets the same finding and score. |
| L-14, L-03, L-16 | **Not now** | No invisible bot check (it would add a third-party service); hiring managers are not limited to their own roles yet (a permission model change for later); no customer second factor of our own (the pilot relies on Google's or Microsoft's two-step sign-in). |
| Migration 0040 | **Not now** | A session left open in another company can still switch back to a company the person was signed out of while they are a member. This needs a migration; this wave allowed none. |
| Known bugs 16 and 17 | **Accepted behaviour** (S5 review) | An application typed with an address already on file joins that person's record at once; what a visitor types in the chat stays apart until the address owner confirms by email. An emailed-in application is read by AI only after the email carrying the AI notice has gone. Details in the change log. |

## 15 October 2026: the Kanvis-style application (Wave S7)

The founder went through Kanvis's application live and asked for the same in Recruiting OS: the resume fills in the form, the company asks its own questions, a chat that keeps asking until it has what it needs, the answers checked before sending, and afterwards the score with where the candidate was strong or short, and the decision when they come back. Built on branch `kanvis-apply` (PR #44, merged 15 Oct as c990949). D-01 revised, S7-1 to S7-4 and F4 are the founder's own answers (15 Oct); the other rows are how Claude built what the founder asked for, on the founder's delegation:

| Id | Decision | What was built |
|---|---|---|
| D-01 revised | **Per-company record** | The candidate's record at one company learns from the chats they send (each fact marked with the chat and date it came from), shows it on their application record to change or remove, and erases it with everything else on a deletion request. A candidate applying again to the same company can ask for an emailed link that fills in their earlier details (name, contact, place, work summary), each marked to check. Keeping facts from earlier chats on the next application came in Wave S8 (below). Never across companies, never public, never the assistant's own notes. |
| S7-1 | **Built** | After Send, the candidate sees their match score (0 to 100) with a bar per requirement named on the job page; everything else the team looks for is one line, "Other things the team looks for". ITS can turn it off per company (on by default) with a reason; customers cannot change it. This reverses the earlier "candidates never see a score". Counsel items 1 and 21 are noted on the page and the switch; a lawyer must review items 21 and 26 before real candidates in New York City, Illinois, California or Colorado. |
| S7-2 (= F2) | **Built** | "Your answers" on the application record: exactly what was sent (details, the company's form questions, each chat answer, skipped and changed ones marked), the assistant's note set apart, the whole chat one click away. Nothing from an unsent chat. |
| S7-3 (= F1) | **Built** | The chat shows a counter ("2 of 4 required · Required questions") and the section name, never the questions or topics in advance. |
| S7-4 (= F3) | **Built in Wave S6** | A button folds the staff left menu to icons, remembered per browser (PR #43, merged 15 Oct as 2df1acb). |
| F4 | **Built in Wave S6** | One dollar figure for the month's AI spend on the ITS console's Costs card is fine (an ITS-only screen). |
| Fairness | **Built** | The match score is monotonic (showing some evidence never scores below showing none); each finding is settled by the middle of the three readings and the overall reading and recommendation are worked out in code from the settled findings; the form's answers reach the reading as plain sentences that count as the candidate's own words. The real-model fairness run on 15 October (run 38717936154, about $0.42) passed all 11 résumé-reading and scoring suites it ran: bias pairs 4/4, consistency 3/3, credentials 9/9, hallucination 6/6, redaction 2/2, fairness rules 5/5. The run after S5 had failed two bias pairs; these fixes settled it. The screening-chat tests have run only on the stand-in AI so far. |
| Company questions | **Built** | On the job's Scoring tab, "Questions every applicant answers": up to 8 quick questions on the form (yes or no, choose one, a number) and up to 5 written questions asked in the chat, each with an optional "What a good answer shows" for the team only. A question about a protected characteristic is refused before it is saved. |
| No automatic rejection | **Unchanged** | Nothing in this wave declines anyone; the score and the write-ups only inform a person. |

## 15 October 2026: the S7 follow-ups (Wave S8)

Claude decided S8-A and S8-B on the founder's delegation; the theme switch is the founder's own request. Built on branch `kanvis-followups` (commits faecec5 and 0b96404); PR #45 is in review, merging 15 October. No migration.

| Id | Decision | What was built |
|---|---|---|
| S8-A | **Written questions in every chat** | A chat started from an emailed link, or by text message, now asks the company's written questions after the questions the résumé reading left open. A job with no written questions asks its screening questions, as before. Chats started before the change keep their old questions. The private "What a good answer shows" note is never said (the code removes it). These chats have no Review & send, but the candidate's record learns from them when they end. Texting itself is still switched off. Small fix still to make: the job's Scoring tab still tells owners that emailed and text chats ask the screening questions instead (`apps/web/src/pages/role/applicant-questions.ts:29`). |
| S8-B | **Earlier facts on the next application** | The form opened from the emailed "Applied here before?" link lists the facts from earlier chats at that company, each ticked; the candidate unticks anything no longer true. Facts are kept only when the email typed matches the one on file, and only if they belong to that person. Without the link, nothing from before is shown or used. The team sees what was kept. The scoring is never told an earlier application existed (D-04 C). Kept facts are erased on a deletion request. |
| Theme switch | **Founder's request** | A sun/moon button beside Sign out switches the staff app between light and dark, remembered on that browser. Candidate pages keep following the device. |

## Still to decide

Reply with the id and a letter, for example "L-02 A, L-05 A". Nothing below changes until you answer. The details and evidence for each are in section 3.

| Id | Your choice | We suggest |
|---|---|---|
| L-02 | Settings shows a seat limit and a trial end that do nothing. **A** remove them, or **B** make them real limits? | **A.** Teammates join free; the trial end becomes a reminder to ITS and the owner, not a lock. |
| L-04 | HR can move someone to the talent pool but cannot send them the message. **A** let HR send the approved talent-pool message, or **B** keep that with owners? | **A.** Only the approved talent-pool wording, never a decline. |
| L-05 | When someone moves a candidate to a new stage, ask for a reason: **A** optional (one tap), **B** always, or **C** never, as today? | **A.** Declines keep their required reason. |
| L-06 | **A** let the team tick several candidates and move them together, or **B** keep one at a time? | **A** for Longlist, Shortlist and On hold, with a preview first. Declines stay in Review and apply. |
| L-07 | **A** let owners try different score weights and preview the new order without saving, or **B** not? | **A**, preview only. Saving still means editing the job. |
| L-08 | When a résumé hides instructions to the AI: **A** tell ITS, **B** tell the hiring team, or **C** tell nobody? | **A.** Look again after the first real cases. |
| L-09 | **A** share a shortlist outside the app (a link or a PDF), or **B** invite the colleague into the app instead? | **B** for now. An expiring link can come after a lawyer has looked at it. |
| L-11 | Candidates' requests to copy or delete their data: **A** ITS handles them, as today, or **B** each customer handles its own? | **A** for the pilot. Later, customers can see their requests without acting on them. |
| L-13 | **A** ask candidates optional equal-opportunity questions (only ITS sees the answers, never the team or the AI), or **B** not yet? | **B** until a lawyer has answered and there are enough applicants to study. |
| L-15 | **A** let a company write a short "house voice" note for the job drafter (text only, no files kept), or **B** not? | **B** for now; **A** later. |
| L-17 | May one person own several companies? **A** only through ITS, or **B** anyone can open more? | **A.** People invited to several companies already have a switcher (Wave S5). |

Put off ("not now"), and open to asking again: D-02, D-05, L-03 (hiring managers see every job), L-14 (no bot check on the apply form), L-16 (our own second sign-in step) and migration 0040.

---

## 1. How to answer

- **Reply with the decision id and one letter**, for example: "L-02 A, L-05 A". If none of the letters fits, say what you want in a sentence.
- You can answer one decision at a time. Unanswered decisions stay pending.
- **Options A and B never authorise deleting an existing feature.**
  - In batch 1, A kept today's workflow and B added the Kanvis-inspired workflow.
  - In **Still to decide**, each row says what its own letters mean.
  - Anything that would remove or switch off something that exists today is named in the option itself and needs your explicit yes.
- **Nothing affected by a pending decision is built or changed until you answer it.**
- Decisions already made are in the dated sections at the top and in section 4, and are not asked again. The questions still open are in **Still to decide** at the top.

**Who is who**

| Person | Meaning |
|---|---|
| Owner | The customer's owner or admin: runs the company's account in Recruiting OS |
| Hiring manager | A customer team member who hires for a role |
| HR | A customer team member in the HR role |
| Interviewer | A customer team member who only interviews |
| Candidate | A job seeker who applies |
| ITS recruiter | An Identified Talent Solutions recruiter, brought in on a role or a candidate |
| Platform admin | ITS staff who run the platform (company checks, privacy requests, plans) |

**How sure we are about Kanvis**

| Label | Meaning |
|---|---|
| OBSERVED | Seen on 14 or 15 October 2026 |
| OBSERVED-EARLIER | Seen on 7 October 2026, not re-checked |
| INFERRED | Read from Kanvis's shipped code, legal pages or marketing text, not seen working |
| UNKNOWN | Not known |

Kanvis has shipped no new version since 7 October: the deployment and its code files were byte-identical on 14 October. Kanvis recruiter access is still waitlist-only, so no recruiter screen could be used. Everything Kanvis does on the recruiter side is therefore either seen in its public demo or INFERRED from its public pages and code. The candidate side was OBSERVED live on 15 October: one complete application to a real employer's job, with the AI interview and the score, in the founder's own candidate account with the founder answering. A voice interview was not seen (only a dictation button), so it stays UNKNOWN.

**Status words used in section 4:** Built, Partly built, Not built.

---

## 2. Batch 1 (asked 14 October 2026; decided the same day by delegation, see the section at the top)

The questions below are kept as they were asked. "Current Recruiting OS behavior" means the app on 14 October, before the decisions were built.

| Id | Workflow | Recommended | Decided |
|---|---|---|---|
| D-01 | Candidate accounts and the candidate side | A now; C's two small pieces later | A (14 Oct, Claude); revised by the founder on 15 Oct to a per-company record (Waves S7 and S8) |
| D-02 | Adding people who did not apply (referrals, walk-ins, CVs already held) | C | Not now, which keeps A (14 Oct, Claude) |
| D-03 | The day-5 automatic decision message (follow-up on B6 and Q27) | A | A (14 Oct, Claude); built in Wave S1 |
| D-04 | What the AI may see when it reads a résumé | C, then re-run the fairness tests | C (14 Oct, Claude); built in Waves S2 and S3 |
| D-05 | Re-reading applicants after a live role's must-haves or skills change | C | Not now, which keeps A (14 Oct, Claude) |

### Decision D-01: Candidate accounts and the candidate side

*Decided: A on 14 October (Claude, by delegation); revised by the founder on 15 October to a per-company record built from the résumé and sent chats. Built in Waves S7 and S8. See the top.*

**Current Recruiting OS behavior:**

Candidates never create an account or a password. A candidate only ever uses a company's public pages and the private links that arrive by email. Each link carries a long random code that is looked up in the database.

| What a candidate has today | Evidence |
|---|---|
| Each company's own careers page and job pages. They are public only after ITS has checked the company (your decision B7). | APPLY-01, APPLY-02, APPLY-03; `apps/api/src/pages/careers-pages.tsx`, `apps/api/src/pages/job-page.tsx` |
| A short apply form: name, email, a résumé or four short written answers, and the role's yes/no questions | APPLY-04 |
| One application per person per role. Applying again changes nothing: the same "check your email" receipt is shown, and the private link is re-sent to the address on file (Q14). | APPLY-12, APPLY-14; `apps/api/src/services/applications.ts:96-100, 173-185` |
| One candidate record per person per company, matched by email (or by phone when no email is given). A public form never overwrites it. | APPLY-13; `packages/core/src/dedupe.ts:23-29`; `apps/api/src/services/applications.ts:76-94` |
| A private status page at `/c/status/:token`. It shows four plain steps (Received, Under review, Interview, Decision) and the messages they received. It also lets them withdraw, set their text-message choice, say "don't keep me for future roles" and make privacy requests. | APPLY-33 to APPLY-38, PIPELINE-40; `apps/api/src/pages/application-record.tsx` (since Wave S7 the "application record": also the match score, the answers sent, the job, the decision once told, and the other applications at the same company) |
| "Lost your link?" re-sends links, only to the address on file | APPLY-15 |
| No profile, no saved details between applications, no candidate tools, and no job board across companies for people to browse | (absence confirmed in the audit) |
| A machine-readable list of every checked company's open roles already exists, for Google and job boards: `/feeds/jobs.xml`, `/feeds/jobs.json`, `/feeds/linkedin.xml`, `/sitemap.xml` | JOBS-34; `apps/api/src/pages/public-feeds.ts:56-58` |

What the founder context asks for:
- A simple status timeline and a mobile-first candidate portal with status, scheduling, preferences, withdrawal and privacy controls (`docs/FOUNDER-CONTEXT.md` section 12 and the MVP list).
- It lists "broad marketplace" as outside the first product (section 27).

**Kanvis-inspired behavior:**

Kanvis is two-sided: candidates have their own accounts and tools.

| Kanvis candidate side | Label |
|---|---|
| A candidate account. A candidate sign-in that opens the recruiter side is sent back to the candidate workspace, so one sign-in appears to be one side only. | OBSERVED (the founder's own candidate account); "one side only" INFERRED from that redirect |
| A profile built from an uploaded CV through a chat with an AI agent. The result is an editable record with many sections, and the chat stays beside it. | OBSERVED (the record and the chat); the first build OBSERVED-EARLIER |
| A public profile page at kanvis.me/username, with a "show in search" switch. There is no way to unpublish it. | OBSERVED |
| An "AI Twin" on the profile that answers visitors' questions about the person | OBSERVED (the chat box only; answers not tested) |
| Résumé builder (four styles, saved versions), cover letter, outreach drafts and a "Job Match" fit check | OBSERVED (entry screens only; nothing generated) |
| A job board across companies, with a match ring, filters and a "why this is on your board" explanation | OBSERVED |
| An applications tracker, capped at 50 applications a month | OBSERVED (empty) |
| Applying with the profile, followed by a short conversational interview. The profile must be published first. | Applying OBSERVED on 15 October: the profile fills the personal details, the employer's own questions come next, then an AI interview with a counter, a review of answers written up from the candidate's replies, and after Send a score out of 100 with six bars. The profile then learned new facts from the interview. "Published first" not checked (the profile was already published). |

**Why this decision matters:**

- **Owner:** a candidate network could bring applicants from outside the owner's own pages. But today each customer has its own careers page, and owners pay for their own hiring, not for a candidate community.
- **Candidate:**
  - An account saves retyping for people who apply often.
  - It adds sign-up work for the many who apply only once.
  - The founder context asks for low friction and never making people retype a résumé they uploaded (section 12).
- **ITS:**
  - Option B makes ITS the holder of candidate profiles across all customers.
  - That needs its own privacy policy, retention rules, deletion and secure candidate sign-in. Today's deletion already misses the AI readings (APPLY-41).
  - It is a second product: months of work, plus AI costs for each candidate tool, with no customer paying for it.
- **Legal (counsel items in `docs/spec/11-counsel-register.md`):** public profiles and matching across companies would need new notices (item 1), a privacy policy (item 16) and retention answers (item 9). None of these is drafted for a candidate side.
- **Strategy:** sourcing and rediscovery were deferred on purpose in September 2026 (section 4, standing principles).
- **Cost:**
  - A costs nothing.
  - C's two pieces are small, a few days of work each.
  - B is large.

**Recommended option:** A now, with C's two small pieces as later options. Candidates already get the status timeline and self-service the founder context asks for, without creating an account. A broad marketplace is outside the first product. C's two pieces would save returning candidates some typing and give ITS one page listing every customer's roles, still without accounts.

**Hybrid possible?** Yes. Option C keeps the no-account model: the emailed private link stays the candidate's key. It adds two conveniences and leaves out Kanvis's accounts, public profiles, Twin and candidate tools.

**What existing functionality could be affected:**
- **A:** nothing.
- **B:**
  - the status page and private links (APPLY-33 to APPLY-39, PLATFORM-28)
  - "Lost your link?" (APPLY-15)
  - repeat applications (APPLY-12, APPLY-29)
  - de-duplication per company (APPLY-13)
  - the per-company separation of candidate records that the database enforces (PLATFORM-11)
  - sign-in (today only team members sign in, with Google or Microsoft: PLATFORM-04)
  - privacy requests (OPS-33)
  - the apply form (APPLY-04)
- **C:**
  - the apply form (pre-filled fields)
  - a new kind of one-time emailed link next to "Lost your link?"
  - a new public page built from the existing feeds (JOBS-34); the ITS company check (B7) decides which companies are listed

**Choose one:**

A. Keep the Recruiting OS workflow: no candidate accounts, one application per role, a private status link.

B. Adopt the Kanvis-inspired workflow: candidate accounts with a reusable profile built from the CV by chat, public profiles, an AI Twin, résumé, cover-letter and outreach tools, a job board across companies with match filters, and an applications tracker.

C. Combine both, without accounts. Two pieces:
   1. **"Apply for another role here with these details."** A candidate's private status page (reached only from their own emailed link) gets a button for applying to another open role at the same company. The apply form then opens with their name, phone, location and last résumé filled in, and they can change anything before sending. It works only within the same company: each company's candidate records are kept apart, so details from one company's application are never carried into another company's form.
   2. **An ITS-wide public jobs page.** It lists the live roles of every ITS-checked customer, and each role links to the company's own job page and apply form. It is built from the existing job feeds.

   No accounts, public profiles, Twin or candidate tools.

D. Make it configurable: ITS decides per company whether its roles appear on the ITS-wide jobs page and whether "apply for another role here with these details" is offered (this only applies to C's pieces).

E. Another approach — let me specify.

**Important:** options A and B do not authorise deleting existing functionality.

### Decision D-02: Adding people who did not apply (referrals, walk-ins, CVs already held, bulk CV import)

*Decided: not now on 14 October (Claude, by delegation). Nothing changed; can be asked again.*

**Current Recruiting OS behavior:**

Nobody on the team can add a person by hand or import CVs.

| Fact | Evidence |
|---|---|
| No manual add or import. The API design promises `POST /applications` ("CreateApplicationManual", manual add or import), but no such route or contract exists. | APPLY-50 (planned, not built); `docs/12-api-contracts.md:146`; comments in `apps/api/src/services/applications.ts:31, 52` |
| Applications are created in only two places: the public apply form and the email-in channel | `apps/api/src/pages/apply-form.tsx` (`createApplication` on Send); `apps/api/src/webhooks/postmark.ts:72, 213` |
| Today a referral or walk-in can be sent the job link (tracked links, one-tap sharing) | JOBS-30, APPLY-16 |
| A CV can also be emailed to the role's own intake address. That creates an application (source "email in") with no answers to the yes/no questions. | JOBS-29, APPLY-43. It needs the inbound mail domain, which is not configured yet (OPS-37). |
| Emailed-in applicants are recorded as having accepted the application terms and the AI notice, which they never saw (a known bug) | known bug 16; `apps/api/src/services/applications.ts:83-87`; `apps/api/src/webhooks/postmark.ts:98-100` |
| Searching for new people ("sourcing") and "rediscovery" of past applicants were deferred on purpose in September 2026 | section 4, standing principles |

**Kanvis-inspired behavior:**

All of this is INFERRED: it comes from Kanvis's "What's new" pages, legal pages and shipped code, read on 7 October. The recruiter screens were never seen, and the 14 October build is identical.
- A recruiter drops up to 50 CVs at a time (PDF, Word, text) into a job. (The pricing page, OBSERVED on 14 October, lists 10 to 50 CVs per upload depending on the plan.)
- Each CV is parsed, scored against the job and listed beside the real applicants. It is marked "Sourced", and a filter shows All, Applied or Sourced.
- Requirements a CV cannot prove are marked pending, not failed.
- An imported CV that shares an email address with another row is flagged as a possible duplicate.
- The recruiter writes one invitation that is personalised for each person and carries a private apply link. People who cannot be sent it (for example no email address on the CV, or a detail the message uses that their CV does not give) are held back, with the reason shown.
- If the person then applies, their real application replaces the imported record.
- The imported record has no account and no public page.
- Kanvis's terms make the recruiter responsible for having a lawful reason to hold the CV and for telling the person.

**Why this decision matters:**

- **Owner and ITS recruiter:** small businesses hire many people through referrals, walk-ins and CVs that land in an inbox, and ITS recruiters hold CVs too. Today each of these people has to be sent the job link and apply themselves.
- **Candidate:**
  - Under B, the AI reads and scores a person before they have applied, seen the AI-use notice, answered the role's yes/no questions or ticked the box that says people decide.
  - Under C, nothing happens to them until they accept.
- **ITS and counsel:**
  - B raises counsel items 1 (AI notice timing), 5 (consent), 9 (how long to keep the CVs of people who never applied), 16 (privacy notice) and 21 (a score on people who never applied, for New York City).
  - B also repeats the email-in consent problem above, at a larger scale.
  - C leaves all of these unchanged for applicants. Only the invitation email is new. Its wording would be approved like other candidate messages, and like every candidate email it waits for the ITS company check (OPS-03).
- **Cost:**
  - B spends AI on every imported CV, even for people who never reply. That is one extraction plus three readings, an estimated 1 to 2 US cents each at the list prices coded in `packages/ai/src/pricing.ts`.
  - C spends AI only on people who accept.

**Recommended option:** C. One click gets referrals and CVs the company already holds into the pipeline, while every applicant still goes through the same notices, questions, consent and AI reading. It also stays inside the September deferral, because it handles people the company already has in hand rather than searching for new ones.

**Hybrid possible?** Yes, C is the hybrid. It takes Kanvis's "add the people you already have" and "invite them with a private link", and keeps the Recruiting OS rule that a person becomes an applicant only by applying.

**What existing functionality could be affected:**
- the apply form, which would gain pre-filled fields and an attached CV (APPLY-04, APPLY-06)
- de-duplication and repeat applications (APPLY-12, APPLY-13)
- tracked links and the "applications per day by source" figures (APPLY-16, JOBS-30, JOBS-41)
- the email-in channel (JOBS-29, APPLY-43), unchanged under A and C
- the outbox and the hold until the ITS company check (OPS-01, OPS-03)
- the screening-conversation allowance, when the role uses the one-visit flow (APPLY-28)
- deletion and retention (APPLY-41, OPS-18), for CVs of people who never accept

**Choose one:**

A. Keep the Recruiting OS workflow: no manual add or import. Referrals use the job link or the email-in address.

B. Adopt the Kanvis-inspired workflow:
   - The owner, a hiring manager, HR or an ITS recruiter uploads CVs into a role.
   - Each CV becomes an application at once, marked as added by the team, and gets the same AI reading and score as applicants.
   - Duplicates are flagged.
   - An optional invitation asks the person to complete their application.

C. Combine both:
   - The owner, a hiring manager, HR or an ITS recruiter uploads CVs, or types a person's name and email, on a role's Talent page.
   - The app sends each person an invitation to apply. The wording is approved, and it is sent only after the ITS company check. The invitation carries a private link to the normal apply form, with their name, email and CV already filled in.
   - The CV is stored privately and is not read by the AI before they accept.
   - They become an applicant only when they press Send, after the same notices, questions and acknowledgment as everyone else. Then the usual reading and score run.
   - People who do not accept are removed, CV included. The plan proposes that the invitation link stops after 14 days and the details and CV are wiped 30 days later; both periods are to be confirmed by counsel (item 9).
   - Meanwhile the team sees them as "Invited, not applied yet", without a score.

D. Make it configurable: ITS decides per company whether the team may add people, and whether that works as in B or as in C.

E. Another approach — let me specify.

**Important:** options A and B do not authorise deleting existing functionality.

### Decision D-03: Telling a candidate about a decision nobody has sent (the day-5 automatic message)

*Decided: A on 14 October (Claude, by delegation). Since Wave S1, every screen and toast that says a decision is private also says the standard message goes by itself after 5 working days (known bugs 19 and 82). The table below shows the wording before that.*

This is a follow-up on two answers you gave on 7 October, not a new question. The two answers pull against each other:
- **B6 (Kanvis way):** decisions are always private. Telling the candidate is a separate, later action by a person.
- **Q27 A:** if a declined candidate has not been told, remind the owner after 2 working days. After 5 working days, send the standard message and tell the owner, unless approval is required or ITS runs the role.

**Current Recruiting OS behavior:**

It is built as Q27 A.

| Step | What happens | Evidence |
|---|---|---|
| The decision | Nothing about the decision is emailed and the candidate's "told" state is set to "not told". (The one exception, from your 9 October answer to Q25: if an interview was booked or times were offered, the candidate gets a short note at once, with no reason, that the interview is off.) A decision is any of these: a person declines one candidate; declines after an interview; declines through "Record what happened"; declines from an eligibility hold; files a group in Review and apply; moves someone to the talent pool; or closes a role, which moves everyone still in process to the talent pool. | PIPELINE-16, -21, -28, -32, -43; `packages/core/src/stages.ts:66, 172` (decision stages = declined and talent pool) |
| Day 2 (working days, in the company's time zone, holidays left out) | The owner is reminded on Today | `packages/agents/src/orchestrator.ts:87-95` |
| Day 5, default setting "Do it" | The standard wording goes out by itself, with no Undo window, and the owner is told who received it. For a closed role it is the closing wording. | PIPELINE-26; `packages/agents/src/decision-messages.ts:251-314`; default in `packages/core/src/policy.ts:97` |
| Day 5, other cases | Nothing is sent, and an ITS recruiter is brought in instead. This happens under "Ask me first" or "Only a person", during an ITS takeover, and when there is no email address on file. A decision whose message is already waiting for an approver is left alone. | `decision-messages.ts:258-288` |
| The setting | The owner or an admin can change it in Setup → What the AI may do on its own → Messages → "Send the decision message". The choices are Do it, Ask me first or Only a person. The setting is per company; the API also allows it per role. | JOBS-19; `apps/web/src/pages/Setup.tsx:267`; `apps/api/src/routes/policies.ts:76-98` |

What the screens say. This is a confirmed bug (known bug 19, medium; known bug 82 for the hire sheet): many places say nothing will be sent, which is not true under the default setting.

| Says nothing goes, or leaves out the day-5 message | Does mention it |
|---|---|
| The decline confirmation for one person (`apps/web/src/talent-actions.ts:213-229`) | The "Not moving forward" group line in Review and apply (`apps/web/src/pages/board/board-model.ts:322`) |
| Both eligibility-hold notifications (`packages/workflows/src/definitions/application-intake.ts:162, 186`) | The "Not told yet" card (`apps/web/src/telling.ts:171-194`) |
| The Review and apply footer and its "applied" toast (`board-model.ts:329, 351`), and the server's privacy line (`apps/api/src/services/review-apply.ts:25`) | The day-2 reminder |
| The hire sheet's "close the role" sentence (`apps/api/src/services/hire-sheet.ts:54-56`) | The toast after closing a role (`talent-actions.ts:289-296`) and the closing-message card |
| Customer guides: `docs/customer/01-what-you-get-and-what-is-not-included.md` line 53; `docs/customer/06-hiring-manager-guide.md` lines 159, 252, 301 | Customer guides: 01 lines 63 and 153; 06 line 280 |

**Kanvis-inspired behavior:**
- Moving a candidate is private, and so is filing a group as "not moving forward" from Review & apply. The demo says nobody was emailed. (OBSERVED in the public demo.)
- Kanvis's recruiter terms say Kanvis contacts nobody on its own and nothing is sent automatically. (INFERRED: legal text read 7 October.)
- Kanvis does send its own automatic emails to candidates (application received, fit report ready). Its changelog says a candidate is told if nobody records a decision within 45 days. (INFERRED: changelog.)
- The candidate settings promise that decisions on applications always reach the candidate. (OBSERVED, in the founder's candidate account.)
- How and when Kanvis tells a candidate about a decision that a recruiter recorded but never sent is UNKNOWN (no recruiter account).

**Why this decision matters:**

- **Owner:** a privately filed decision reaches the candidate on day 5 unless someone acts. That includes a batch of up to 50 people from Review and apply, and everyone left in process when a role closes. Most screens tell the owner the opposite, which can cause surprise or embarrassment.
- **Candidate:**
  - The automatic message gives closure. The founder context wants even a rejection to give closure (section 12), and the job page promises "a real answer either way" (APPLY-02).
  - Without it, a forgotten decision leaves people waiting with no answer.
- **ITS:**
  - Options B and C turn every forgotten decision into ITS recruiter work.
  - The recruiter request that the day-5 step opens is not emailed to the ITS queue mailbox today (OPS-12). Under B it would sit in the queue unnoticed unless that is fixed.
- **Counsel:**
  - Item 23(c) asks exactly this timing question.
  - Item 22's text says "nothing sent until a person sends the decision message", which does not match the default. Both items need the same answer.
  - Use with real candidates waits for counsel either way.
- **Cost:**
  - A: wording changes only.
  - B: a change of default, plus ITS recruiter time.
  - C: a moderate change.
  - D: a moderate change: one new setting, plus a one-time data step that keeps today's behaviour for existing companies.

**Recommended option:** A. It is what you chose in Q27, and it makes sure every candidate gets an answer. The only defect is honesty, and it can be fixed:
- Every place that says "nothing is sent" should instead say "if nobody tells them by <date>, the standard message goes by itself", with the date counted in the company's working days.
- The customer guides and counsel item 22's text should be corrected to match.

**Hybrid possible?** Yes, in two ways:
- C keeps the automatic message for decisions made one at a time, and keeps batch and role-closing decisions with a person.
- D lets each company choose what happens on day 5, through a new setting kept apart from today's "Send the decision message" setting.

**What existing functionality could be affected:**
- the day-5 step (PIPELINE-26)
- private decisions and telling the candidate (PIPELINE-21 to PIPELINE-25)
- Review and apply (PIPELINE-16)
- the closing message (PIPELINE-27)
- eligibility holds (PIPELINE-28)
- "Record what happened" (PIPELINE-43)
- the hire sheet (PIPELINE-34)
- the Setup rule text (JOBS-19)
- recruiter requests and the queue mailbox (OPS-12, OPS-13)
- customer guides 01 and 06
- counsel items 22 and 23
- the tests `apps/api/src/telling-candidates.test.ts` and `apps/api/src/pipeline-marks.test.ts`

**Choose one:**

A. Keep the Recruiting OS workflow (Q27 A as built). The day-5 standard message stays the default. Every decline, talent-pool and role-closing screen, toast and notification says so, with the date.

B. Adopt the Kanvis-inspired workflow (strict B6; Q27 option B):
   - Never send a decision message automatically.
   - Remind the owner on day 2 and again on day 5.
   - Then bring in an ITS recruiter to make sure the person is told.

C. Combine both:
   - The day-5 message stays automatic only for decisions a person made one at a time: a single decline, an eligibility decline, a decision after an interview, or "Record what happened".
   - Decisions filed in a batch from Review and apply, and talent-pool moves made by closing a role, are never sent automatically. On day 5 they bring in an ITS recruiter, as in B.
   - Every screen says which rule applies.

D. Make it configurable: a new, separate setting in Setup (owner or admin) for day 5 only: "send the standard message" or "bring in an ITS recruiter". It is separate because today's "Send the decision message" setting also controls what happens when a person presses Send themselves, and that should not change. Existing companies keep today's behaviour; you choose which day-5 choice new companies start on. Each decline screen shows the company's current rule and the date.

E. Another approach — let me specify.

**Important:** options A and B do not authorise deleting existing functionality.

### Decision D-04: What the AI may see when it reads and scores a résumé

*Decided: C on 14 October (Claude, by delegation). Built in Wave S2; the fairness tests and the earlier-rejection pair were added in Wave S3 and passed on the real model. After S5 a run found the score could drop when more evidence was shown (two bias pairs failed); S7 fixed it, and the run after S7 passed. The table below shows what the reading received before that.*

On 13 October you decided **how** the reading is done: three readings and the middle answer, high effort, one written definition per finding, and the candidate never named in the reading's own words. This decision is only about **what goes in**.

**Current Recruiting OS behavior:**

The résumé reading (task `triage.assess`, Claude Haiku 5.5, read three times) receives the following:

| Input | Sent to the reading? | Evidence |
|---|---|---|
| The full résumé text, up to 40,000 characters. It normally includes the name, email, phone, home address, web links, schools and graduation years. | Yes | `packages/ai/src/prompts/triage.ts:67` |
| Facts extracted earlier: jobs, licences, certifications, skills, years of experience, anomalies. The extraction's name, email, phone, location, headline, education and languages are left out of this part (they are still in the résumé text above). | Yes | `triage.ts:68` |
| The answers to the role's yes/no questions, and the result | Yes | `triage.ts:69` |
| The person's other applications to the same company: role title, how far they got (for example "rejected" or "withdrawn") and the date | Yes | `packages/workflows/src/definitions/application-intake.ts:209-218`; `triage.ts:70` |
| The role: must-haves, skills, pay range | Yes | `triage.ts:37-46` |
| Photos or images | No. Résumés are read as text only, with no OCR. | APPLY-09 |
| Team notes | No | PIPELINE-31 |

What follows from these inputs:
- **No filtering:** the AI is told not to consider protected traits or anything that stands in for them, and to call the person "the candidate" (`packages/ai/src/prompts/registry.ts:37-57`). But nothing is removed before it reads (AI-21, partly built).
- **What the reading drives:** code works out the 0-100 match score from the reading's checked findings (PIPELINE-11). On roles using the usual "form now, conversation later" path, the reading also decides whether the screening invitation goes out automatically (AI-17). On one-visit roles (B1) the conversation is offered before the reading runs.
- **Fairness tests:** they compare pairs of résumés that differ only in name, graduation year or ZIP code (`packages/evals/src/suites.ts:452-459`).
  - No test varies earlier applications (known bugs 84 and 136; pipeline audit section 8).
  - The candidate notices do not mention that earlier applications are considered.
- **What the team sees:** earlier applications are not shown in one place. Each stays on its own role's Talent page.
- **The screening scorecard** (`screen.assess`) reads the conversation, its recorded answers and the role, not the résumé text or earlier applications (`packages/ai/src/prompts/screen.ts:121-139`). The conversation itself greets the candidate by first name (`packages/ai/src/prompts/screen.ts:94`).

**Kanvis-inspired behavior:**
- Kanvis says its scores are calculated from the interview record. (INFERRED: marketing.)
- Its terms rule out inferring protected traits, and rule out criteria that stand in for them. (INFERRED: legal text read 7 October.)
- The candidate settings list identity details, such as date of birth, as a separate store, and say they are sent only to a company whose form asks for them. (The wording is OBSERVED, in the founder's candidate account under Settings → Your data; the behaviour itself was not tested.)
- Whether Kanvis hides names or contact details from the model that scores is UNKNOWN.

**Why this decision matters:**

- **Candidate:**
  - An earlier "no" from the same company can colour a fresh reading for a different role, and the automatic screening invitation that reading can trigger.
  - Names and addresses can carry signals about ethnicity, gender or neighbourhood. The AI has been told to ignore them but still reads them.
- **Owner:** the score and the board's suggestions come from this reading, so a biased input changes the order of the list. The team keeps seeing everything; only the AI's input changes.
- **ITS and counsel:**
  - A cleaner input strengthens the answers to counsel item 21 (the New York City bias audit for a visible score) and item 7 (automated-decision rules).
  - The founder context points the same way: section 10 (never infer protected traits), section 22 (collect only what is needed) and section 26 (monitor for bias).
- **Cost and risk:**
  - Removing items is done by code before the AI call, so there is no extra AI cost.
  - Re-running the fairness tests uses the existing "Run fairness tests" button, at a small real-model cost.
  - Risk: hiding text could remove words the reading wants to quote, so the quote checks must run against the same cleaned text.
  - A location must-have still needs the city, so city and state stay.

**Recommended option:** C, then re-run the fairness tests, adding a pair of résumés that differ only in an earlier rejection.
- It removes the clearest unfair input (earlier outcomes), plus identity details that never help judge the work.
- The extraction still fills in the record for the team.
- Under C, schools and graduation years stay visible to the AI, because they can matter for the job (a required degree, for example). If you want those hidden too, choose E and say so.

**Hybrid possible?** Yes, C is the hybrid. The team keeps the full picture, and the AI's reading sees only what judges the work.

**What existing functionality could be affected:**
- the résumé reading (AI-15) and its quote checks (PIPELINE-08)
- the match score and the pool board (PIPELINE-11, PIPELINE-14)
- the automatic screening invitation (AI-17)
- "Ask about this in a screen" questions (AI-20)
- the fairness tests and evaluations (AI-23, AI-24)
- the handling of hidden instructions in résumé text (AI-22, APPLY-48)
- the candidate notices, if they need to say what the AI reads

The extraction (AI-14) and what the team sees do not change.

**Choose one:**

A. Keep the Recruiting OS workflow: the full résumé and earlier applications go to the reading.

B. Adopt the Kanvis-inspired workflow, in its narrow form (the score rests on the evidence about the work, not on the person's history with the company): remove earlier applications and their outcomes from the AI's input only. The team still sees them on each role.

C. Combine both:
   - Do B.
   - Also hide the name, email, phone, street address and web links (LinkedIn included) from the résumé text before the scoring reading. The extraction still reads them to fill in the record, and city and state stay. Photos never reach the AI today.
   - Then re-run the fairness tests, adding a pair that differs only in an earlier rejection.

D. Make it configurable: ITS decides per company whether B or C applies. It is ITS rather than the owner because this is a fairness control.

E. Another approach — let me specify (for example, also hide schools and graduation years).

**Important:** options A and B do not authorise deleting existing functionality.

### Decision D-05: Re-reading applicants after a live role's must-haves or skills change

*Decided: not now on 14 October (Claude, by delegation). The labels stay; nothing re-reads. Can be asked again.*

**Current Recruiting OS behavior:**

| Fact | Evidence |
|---|---|
| When an approver (for example the owner) changes a live role's must-haves, skills or how much a skill counts, the new version goes live at once (unless it carries a fairness flag nobody has dealt with). Q10's approval step covers only pay, title, place and the yes/no questions. | JOBS-17, JOBS-18; `apps/api/src/services/packet-versions.ts:145-164` |
| People already read keep their reading and score, worked out against the version they were read against. That includes the old importance of each skill, so even a change of importance does not re-order them. | `apps/api/src/services/pool.ts:82-84`; `packages/core/src/match-score.ts:104-108` |
| Their row shows "Read against version N of the role; the role is now on version M", and adds "Its must-haves have changed since" when they have | AI-37, PIPELINE-13; `match-score.ts:180-186`; `apps/web/src/pages/People.tsx:320`; `apps/api/src/routes/compare.ts:104` |
| The pool board never suggests "Not moving forward" for someone read against must-haves that have since changed. It puts them under "Needs your eye" instead. | `packages/core/src/board.ts:147`; `docs/spec/22-match-score-and-pool-board.md` section 2 |
| Anyone who applies after the change is read against the new version | `apps/api/src/services/applications.ts:107`; `application-intake.ts:385-393` |
| Nothing re-reads anyone: there is no button, route or background job. The database column meant for it (`assessments.superseded_by`) is unused. "Re-read after a role change" is in the 7 October backlog. | AI-37; `packages/db/src/schema/hiring.ts:362` |

**Kanvis-inspired behavior:**

All of this is INFERRED: it was read from Kanvis's shipped code on 7 October. The scoring screens were never seen working, and the 14 October build is identical.
- Changes only to weights, names or marks update the ranking at once.
- Structural changes to the scoring rubric re-score every applicant, which takes a few minutes.
- A "Re-score all" action re-runs scoring after the job description is edited. It is limited to 5 per hour, and candidates are not told.
- A "Tune ranking" drawer lets the recruiter drag weights and watch the list re-order (see L-07).

**Why this decision matters:**

- **Owner:** after a role is tightened or loosened, the list mixes people judged against two different versions of it. The label warns the owner, but working out who would now rank where is left to them.
- **Candidate:** someone read against an older must-have they lacked keeps a low score even though that requirement is gone. The board does stop suggesting a decline for them.
- **ITS:** an automatic re-read (B) spends AI on every edit, including small ones, and moves scores the team has already acted on.
- **Cost:**
  - One re-read is three Haiku readings, roughly one US cent or less per person (about 2 US dollars for 200 people). This is an estimate from the list prices coded in `packages/ai/src/pricing.ts`.
  - There is no daily AI spending cap (AI-06), so B could spend that again on every edit.
- **Safety:** a re-read must never send anyone a new screening invitation or message by itself. The 7 October backlog item already ruled out candidate messages for a re-read.
- **Counsel:** nothing new. The re-read uses the same reading and rules.

**Recommended option:** C. The owner decides when a re-read is worth it and sees the cost first, and nothing moves behind the team's back. New applicants are already handled.

**Hybrid possible?** Yes, C is the hybrid. It takes Kanvis's re-scoring and keeps the Recruiting OS rule that the team sees, and starts, anything that changes.

**What existing functionality could be affected:**
- the version label (AI-37, PIPELINE-13)
- the score, the pool board and Review and apply (PIPELINE-11, PIPELINE-14, PIPELINE-16)
- Compare (PIPELINE-20)
- the role report's "AI suggestions vs human decisions" (PIPELINE-36)
- the automatic screening invitation (AI-17), which must not fire on a re-read
- role versions (JOBS-17)
- the AI cost views (AI-05)

**Choose one:**

A. Keep the Recruiting OS workflow: the labels only; nothing re-reads.

B. Adopt the Kanvis-inspired workflow: re-read everyone automatically on every change to the must-haves or skills.

C. Combine both:
   - After such a change, the Talent page offers "Re-read N applicants against the new version", where N counts people still undecided. The approximate cost is shown before the owner confirms.
   - The re-read runs the same three readings. No candidate is contacted and no automatic step fires. The old reading stays in the History tab.
   - A change only to how much a skill counts is applied to everyone at once without the AI, because the score is arithmetic.
   - As today, new applicants are read against the version that is live when they apply.

D. Make it configurable: the owner chooses in Setup between "ask me first" (as in C) and "re-read automatically" (as in B).

E. Another approach — let me specify.

**Important:** options A and B do not authorise deleting existing functionality.

---

## 3. Later batches (the details behind "Still to decide")

These come from the Recruiting OS / Kanvis comparison. L-01, L-10 and L-12 were decided on 15 October and built in Wave S5; L-03, L-14 and L-16 were put off ("not now") the same day. The rest are asked in the short table **Still to decide** at the top; the rows below give the background. Feature ids starting with CMP- are the comparison's own ids. The other ids are from `docs/audit/feature-inventory.md`, and bug numbers are from `docs/audit/known-bugs.md`.

### Batch 2: Who may decide what

| Id | Question | Summary | Recommendation | Evidence |
|---|---|---|---|---|
| L-01 (decided 15 Oct, as recommended; see the top) | Who may keep a fairness-flagged phrase on a live job, and must the named decision maker see wording edits? | An approver can keep wording the fairness check flagged on a live job, with their own reason, and it goes public with nobody else looking, although nobody may approve their own new role. Wording-only edits also skip the role's named decision maker. (Q10 settled what needs approval, not who may override a flag.) | A second approver must agree before a kept flag goes live (a sole owner excepted, as for new roles). The named decision maker is told about wording edits after they go live, without blocking them. | CMP-029; JOBS-11, JOBS-17; bugs 11, 59 |
| L-03 (not now, 15 Oct; see the top) | Should hiring managers be limited to the roles they manage? | Today any hiring manager sees and acts on every role's candidates, declines included. The spec marks the limit for release 2. | Yes: by default a hiring manager sees only roles where they are named, and an owner switch can give a hiring manager every role. | CMP-136; PLATFORM-35 |
| L-04 | HR can file someone into the talent pool but cannot tell them: is that intended? | HR may move people to the talent pool, but may not send decision messages. HR's decision therefore waits for a colleague or the day-5 message, which ties it to D-03. | D-03 stayed A, so: let HR send the approved talent-pool wording (not decline wording). | CMP-107; PIPELINE-21, PIPELINE-43 |

### Batch 3: Reviewing, moving and interviewing candidates

| Id | Question | Summary | Recommendation | Evidence |
|---|---|---|---|---|
| L-05 | A reason on every stage move: optional or required? | Moves to Longlist, Shortlist, On hold or Interviewing need no reason today; declines already need one from a fixed list. A reason makes the history explainable and later learning possible, but adds a click to every move. | An optional one-tap reason on every move. It stays required only where it already is (declines, keeping a held person in). | CMP-085; PIPELINE-03, PIPELINE-04 |
| L-06 | Select many people on the Talent list and move them together? | Today the list moves one person at a time; only Review and apply (from the pool board) works on groups of up to 50. Bulk moves save time on big pools, but must not become a way round the per-person decline reasons of B4. | Yes for Longlist, Shortlist and On hold, with a preview first. Declines stay in Review and apply. | CMP-087; PIPELINE-16, PIPELINE-17 |
| L-07 | Let owners try different weights and preview the re-ordered list before saving? | The score uses fixed weights by importance, so an owner cannot see how a stricter or looser role would re-order the list without editing the role. A saved change of weights changes what the score means. | Preview only, clearly labelled, with nothing saved. Saving means editing the role, which creates a new version, and D-05 then applies. | CMP-081; PIPELINE-11 |
| L-09 | Share a shortlist outside the app (an audited page or a PDF)? | The founder context wants one-click sharing of candidates. Today a shortlist is seen only inside the app (Compare shows up to five people). A page or PDF moves candidate data outside the access rules and the audit trail. | Not yet. Invite the colleague into the company as an interviewer or hiring manager instead, and revisit an expiring, audited share page after counsel. | CMP-139; PIPELINE-20 |
| L-12 (decided 15 Oct, as recommended; see the top) | When our own interviewer misses an interview: re-offer the same round automatically, or let the owner choose? | When our own interviewer misses an interview, the approval card proposes the next round and the candidate gets no apology. The spec intended the owner to be offered a reschedule. | Let the owner choose, with "offer the same round again" as the first choice and an apology line in the new invitation. | CMP-128; INTERVIEWS-17, INTERVIEWS-19; bug 95 |

### Batch 4: Fairness, safety and what the AI reads

| Id | Question | Summary | Recommendation | Evidence |
|---|---|---|---|---|
| L-08 | Tell the team when a résumé contains hidden instructions to the AI (an integrity notice)? | Since Wave S2, candidate text can no longer break out of the scoring readings' data blocks. The résumé extraction and the chat's own turns are not hardened yet, and no test tries hidden instructions (known bugs 31 and 15, both fixed in part). Kanvis shows such a notice without penalising the candidate (INFERRED), but the notice itself could bias the reader. | Tell ITS (not the hiring team) when something was found. Revisit after the first real cases. | CMP-106; APPLY-48, AI-22 |
| L-13 | Voluntary equal-opportunity questions, kept apart from every AI input? | Lawful bias monitoring (founder context section 26) needs voluntary demographic answers, kept away from every AI input and from hiring decisions. It adds sensitive data and counsel work. | Not before counsel answers and there are enough applicants to analyse. When built, only ITS sees the answers, never the team or the AI. | CMP-163; AI-21 |
| L-14 (not now, 15 Oct; see the top) | An invisible bot check on the apply form? | The apply form has a hidden trap field and rate limits, but no bot check. Each fake application costs two AI calls and emails whatever address was typed. Any check adds some friction for real candidates. | Add an invisible check (no puzzle), keep the trap field, and turn it on before public launch. | CMP-060; APPLY-05; bug 70 |
| L-15 | A company "house voice" and reference documents for the job drafter (text only)? | Drafts would sound like the company if the drafter could use a short house-voice note and some reference text. But keeping company documents is what Q7 avoided for role files. | Later: a text-only house-voice box in Setup, with no files kept, used only by the job drafter. | CMP-033; AI-29, JOBS-08 |

### Batch 5: Company accounts, plans and privacy duties

| Id | Question | Summary | Recommendation | Evidence |
|---|---|---|---|---|
| L-02 | Seats and trial end: enforce them, or drop them from Setup? | Setup shows a seat allowance and a trial that do nothing: seats are never counted and the trial never ends. Kanvis sells seats per plan, so this is a pricing choice. (Monthly allowances never resetting was a separate bug, fixed in Wave S2: known bug 2.) | Remove the seat line: the founder context avoids per-user pricing so managers join freely (section 20). Make the trial or pilot end a reminder to ITS and the owner, not a lock. | CMP-014; JOBS-06, OPS-25, OPS-29; bugs 60, 128 |
| L-10 (decided 15 Oct, as recommended; see the top) | Let a member leave a company, and an owner close the company account? | Before Wave S5 there was no way out: only another manager could remove a member, and no one could close a company. What happens to the company's candidate data must follow the retention rules (counsel item 9). | Build "leave this company" now. Make "close the company" a request to ITS that follows the retention schedule once counsel answers. | CMP-013; PLATFORM-37 |
| L-11 | Let customers handle their own candidates' privacy requests? | Only an ITS platform admin can handle a candidate's request to copy, correct or delete their data today. Moving this to customers changes who answers for the 45-day deadline. | Keep it with ITS during the pilot (counsel item 6). Later, show customers their requests read-only. | CMP-143; PLATFORM-34 |
| L-16 (not now, 15 Oct; see the top) | Should customer owners and admins need a second sign-in step (an authenticator code) for release 1? | ITS staff already must use one. Customer owners and admins sign in with Google or Microsoft only, and the customer guide asks them to turn on two-step sign-in at Google or Microsoft. | Keep relying on Google's or Microsoft's own two-step sign-in for the pilot, and show owners a reminder in Setup. Add our own code for owners and admins before wider launch. | PLATFORM-08; `docs/product-audit.md` section 11.2 |
| L-17 (in part: the switcher was built in Wave S5) | May one person belong to, or own, several companies? | Invitations let a person join a second company, and since Wave S5 a company switcher lets them reach both (known bugs 9 and 49 fixed). By a direct API call one person can still open several trial companies (known bug 65). | Yes for invited members, with a company switcher (fix F-07). Opening a second company of your own goes through ITS. | PLATFORM-26; ROUTES-35; bugs 9, 49, 65 |

---

## 4. Decisions already made (do not re-ask)

These are reproduced from the decision record, with where each one lives in the code today. The one real conflict between two recorded answers (B6 and Q27) was settled by D-03 A. Nothing here is asked again. The decisions of 14 and 15 October are in the dated sections at the top.

### 4.1 Kanvis adoption: answered 7 October 2026, built in PR #26 (merged to main 11 October 2026 as 081a806)

The plan question numbers Q1, Q15, Q18, Q21, Q22 and Q26 were answered as B7, B1, B2, B4, B5 and B6. Q20 (a Shortlist mark) was replaced by B3.

| Id | Plan Q | Answer | What you decided | Where it lives in the code | Status |
|---|---|---|---|---|---|
| B1 | Q15 | A | The AI screening conversation in the same visit as applying, for everyone past the yes/no questions. The candidate can choose Start now, Do this later or Talk to a person. Pilot roles first, and ITS switches it on per company or role. Roles set to "ask me first" stay on the later path. | `apps/api/src/services/apply-conversation.ts:90-126`; `packages/core/src/apply-flow.ts:15`; `apps/api/src/routes/roles.ts:283-331`; `apps/api/src/routes/admin.ts:113-133`; migration 0033 (APPLY-18 to APPLY-24) | Built. It is off until ITS switches a company or role on. |
| B2 | Q18 | B | A 0-100 match score on every applicant, worked out by code from checked findings (never written by the AI), with a points-lost breakdown and sorting. Bands use our own words. Missing information is set aside, not penalised. | `packages/core/src/match-score.ts:108-146`; `packages/contracts/src/domain/match.ts` (PIPELINE-11, AI-16) | Built. Use for New York City waits for counsel item 21. Since S7-1 (15 Oct) candidates also see their own score and breakdown after Send (ITS switch, on by default). |
| B3 | new | A | A stage strip with counts and a stage button for each candidate. Moves that need a real event open that step. Moves are private; candidates see only simple steps. | `packages/core/src/stages.ts:269-304`; `apps/api/src/services/application-actions.ts:209-254`; `packages/core/src/marks.ts`; migration 0026 (PIPELINE-02 to PIPELINE-04, PIPELINE-40) | Built |
| B4 | Q21 | B | Pool review ("Review and apply") can file the weakest group as "not moving forward" in one batch, privately, each person with their own evidence-based reason, and nobody emailed at that moment. | `apps/api/src/services/review-apply.ts`; `apps/web/src/pages/board/ReviewApply.tsx`; `apps/api/src/routes/roles.ts:530-537` (PIPELINE-16) | Built. The day-5 message applies afterwards: see D-03. |
| B5 | Q22 | A | One-click questions about the pool first; a free-text "Ask AI" chat later, after real-model testing. | `packages/core/src/pool-summary.ts:113-180`; `apps/web/src/pages/board/AskPool.tsx` (PIPELINE-18) | Built. Free text is not built, as decided (PIPELINE-19). |
| B6 | Q26 | B | Decisions are always private; telling the candidate is a separate, later action by a person. | `packages/core/src/stages.ts:172` (told state); `apps/api/src/services/application-actions.ts` (reject, send_decision, told_in_person, undo_decision); `apps/api/src/pages/application-record.tsx` (`decisionHeadline`: shown only once told; PIPELINE-21 to PIPELINE-25) | Built. Its fit with Q27 was settled by D-03 A (14 Oct). |
| B7 | Q1 | A (= plan B) | Open sign-up, but the careers page, job pages, Google listing and first candidate emails wait for a one-time ITS company check. | `apps/api/src/services/company-trust.ts:32-76`; `apps/api/src/pages/careers-pages.tsx`; `packages/agents/src/outbox.ts:88-165`; migration 0027 (JOBS-02, APPLY-03, OPS-03) | Built |
| Q2 | | A | No email-code sign-in: Google or Microsoft only. | `apps/api/src/routes/auth.ts:42-86`. An email sign-in link remains only as a development aid, off by default in production (`apps/api/src/env.ts:136`). (PLATFORM-04, PLATFORM-05) | Built |
| Q3 | | A | A short company form plus time zone; the rest is collected later (getting-started card, kick-off call, first hiring conversation). | `apps/web/src/pages/CompanySetup.tsx`; `apps/api/src/services/companies.ts:16-49`; `apps/api/src/services/brief.ts:434-539` (JOBS-01, JOBS-03) | Built |
| Q4 | | A | A full-screen drafting space at /roles/new (conversation and live draft side by side), not a new menu section. | `apps/web/src/pages/NewRole.tsx`; `apps/web/src/pages/new-role/Builder.tsx`; `apps/api/src/routes/intake.ts` (ROUTES-11, JOBS-08, JOBS-09) | Built |
| Q5 | | A | Today's box stays, labelled for describing a new role, and opens the drafting space with the words carried over. | `apps/web/src/pages/new-role/TodayStart.tsx`; `apps/web/src/pages/new-role/use-start-draft.ts` (JOBS-07) | Built |
| Q6 | | A | Draft roles are visible to the drafter and to owners and admins, who can take them over. An ITS recruiter sees them only if brought in. | `apps/api/src/routes/intake.ts:62-77, 367-385`; migration 0030 (JOBS-10) | Built |
| Q7 | | A | Attachments when opening a role are turned into editable text and the file is not kept. | No code: the drafting space has no attachment upload. | Not built (left in the backlog, as decided) |
| Q8 | | A | The first full draft comes after one round of up to three tap-to-answer questions (or "draft it"). Missing items show as "not set yet". Approval is blocked until six essentials are set and a person has set or confirmed the pay. | `packages/core/src/intake-builder.ts:167-202`; `packages/agents/src/intake.ts:177-206` (JOBS-08, JOBS-15) | Built |
| Q9 | | A | The pay range is always shown on the job ad. | `packages/core/src/packet-guard.ts:216-222` | Built |
| Q10 | | B | Edits to a live job's pay, title, location or yes/no questions need approval like a new role; wording-only edits go live after a preview. | `apps/api/src/services/packet-versions.ts:45, 134-184` (JOBS-17) | Built. Who may keep a flagged phrase: L-01 (built in Wave S5). |
| Q11 | | B | Careers page and Google always; LinkedIn and Indeed when the plan names them; ZipRecruiter only with the company's own paid plan; the ticks can be changed. | `apps/web/src/components/BoardTicks.tsx`; `apps/api/src/routes/postings.ts:453-553`; `packages/core/src/posting-tasks.ts` (JOBS-24 to JOBS-26) | Built. Boards are posted by hand (ITS posting tasks or the team); no job-board API connections (JOBS-39). |
| Q12 | | B | A closing date stops new applications at the end of that day. People part-way through can finish, nobody is rejected, and the owner is told and can extend. Closing the role stays a human decision. | `apps/api/src/services/closing-date.ts`; `packages/workflows/src/definitions/closing-date.ts`; `apps/api/src/routes/roles.ts:241-281` (JOBS-31, APPLY-17) | Built |
| Q13 | | B | The AI drafts "about the company"; the owner edits and approves it once in Setup. | `apps/api/src/services/company-settings-profile.ts:98-120`; `packages/ai/src/prompts/company-about.ts`; `apps/web/src/pages/Setup.tsx:626-633` (AI-12, JOBS-04) | Built |
| Q14 | | A | Every applicant gets the same "check your email" receipt; the status page is reached only from the emailed link. This closes the repeat-application privacy hole. | `apps/api/src/pages/apply-form.tsx` (the `/applied` receipt); `apps/api/src/services/applications.ts:173-185` (APPLY-12, APPLY-14) | Built. A related leak in the one-visit flow (known bug 17) was fixed in part in Wave S5; the rest is accepted behaviour (section at the top). |
| Q16 | | A | A candidate who chooses a person can either "send without the conversation" or "have a person contact me" (ITS within 4 business hours). | `apps/api/src/pages/chat-pages.tsx` (`/c/screen/:token/person`); `packages/agents/src/screening.ts:686, 716` (APPLY-24) | Built |
| Q17 | | A | Conversation allowance: warn at 80%. If it runs out, keep accepting applications and send the conversation link once it is topped up. | `apps/web/src/allowance.ts`; `packages/agents/src/screening.ts:326`; `packages/workflows/src/definitions/screen.ts:121-146` (APPLY-28) | Built. Allowances reset each month since Wave S2 (known bug 2 fixed). |
| Q19 | | A | Deal-breakers are offered back as visible must-haves, after the fairness check. | `packages/core/src/intake-builder.ts:661` | Built |
| Q23 | | A | Candidate panel sections (Overview, Screen, Résumé, Messages, Notes, History), with "waiting for you" at the top and markers for what is new. | `apps/web/src/pages/candidate-panel/helpers.ts:14-19`; `apps/web/src/pages/candidate-panel/needs-you.tsx` | Built |
| Q24 | | B | Private team notes with before- and after-interview starters and no ratings. Interviewers add only their own after-interview note. Launch after counsel. | `apps/api/src/services/notes.ts`; `apps/api/src/routes/notes.ts`; migration 0034; `apps/web/src/pages/candidate-panel/notes.tsx`; `apps/web/src/pages/Interviews.tsx` (PIPELINE-31, INTERVIEWS-21) | Built. Use with real candidates waits for counsel item 25. |
| Q25 | | A | Declining someone with a booked interview cancels the interview, after a confirmation. 9 October follow-up: the candidate is told at once, with no reason, that the interview is off. | `apps/api/src/services/exit-cleanup.ts`; `apps/web/src/talent-actions.ts:213-229` (INTERVIEWS-33) | Built |
| Q27 | | A | An untold declined candidate: remind after 2 business days; after 5, send the standard message and tell the owner (unless approval is required or ITS runs the role). | `packages/agents/src/decision-messages.ts:251-314`; `packages/agents/src/orchestrator.ts:87-95`; `packages/core/src/policy.ts:97` (PIPELINE-26) | Built. D-03 A (14 Oct) kept it, and the screens say so since Wave S1. |
| Q28 | | A | Declines use approved wording plus an optional personal line. The AI may suggest lines for invitations and updates, and those emails say AI helped. | `packages/agents/src/coordinator.ts:163-171`; `apps/api/src/services/application-actions.ts:369-382`; `packages/agents/src/personal-line.ts`; `packages/agents/src/message-line.ts` (PIPELINE-22, AI-13) | Built. The wording is a draft for counsel item 23. |
| Q29 | | B | A record-only "Offer made" step (date, private note), then Accepted or Declined. The app never writes or sends the offer. | `apps/api/src/services/offers.ts`; `apps/api/src/routes/roles.ts:898-912`; `apps/web/src/pages/candidate-panel/hiring.tsx` (PIPELINE-33) | Built |
| Q30 | | B | When a role closes: one courteous closing message, approved once, and candidates stay in the talent pool unless they opt out. | `packages/agents/src/decision-messages.ts` (closingAudience, queueClosingMessages); `apps/api/src/services/closing-messages.ts`; `apps/web/src/components/ClosingMessage.tsx`; `apps/api/src/routes/roles.ts:485-505` (PIPELINE-27) | Built |
| Q31 | | A | An ITS recruiter brought in by the system may start at once, with narrow access, and the owner is told immediately. | `apps/api/src/routes/approvals-escalations-events.ts:105, 318, 451-466`; `packages/core/src/staff-access.ts` (PLATFORM-21, PLATFORM-38) | Built |
| Q32 | | A | An "urgent" recruiter request goes to the front of the ITS queue, with the same reply-by time, and the screen says so plainly. | `packages/core/src/escalations.ts:73`; `packages/core/src/business-hours.ts:187`; `apps/api/src/routes/approvals-escalations-events.ts:139` | Built |
| Q33 | | A | The recruiter-request allowance never blocks a request. Only the team's own requests are counted, and going over is flagged to ITS for billing. | `apps/api/src/routes/approvals-escalations-events.ts:163-181`; `apps/api/src/routes/admin.ts:43`; `apps/api/src/services/review-apply.ts:200` (OPS-10) | Built |
| Note | | | "yes i like the design of kanvis.me": a Kanvis-like visual refresh, in our own identity (Wave DS). | `packages/ui/src/tokens.css`; `packages/ui/src` | Built |
| 9 Oct | | | Unsent conversation answers stay hidden from the team until the candidate presses Send; unfinished ones are never shown. | `packages/core/src/screen-answers.ts`; `packages/agents/src/screening.ts:753-783` (APPLY-23) | Built |
| 9 Oct | | | The 30-day "still reviewing" note is off by default ("with thousands of applicants we only pick the best few"). | `packages/core/src/policy.ts:68`; `packages/agents/src/decision-messages.ts:336-363` (PIPELINE-39) | Built (off by default) |

### 4.2 Cancelled interviews: 9 and 10 October 2026 (PR #27, migration 0035)

| Id | What you decided | Where it lives in the code | Status |
|---|---|---|---|
| 1A | A "Cancelled" column in each role's stage strip, next to Interviewing, with its own count. It is used only when the candidate cancels. | `packages/db/migrations/0035_interview_followups.sql`; `packages/core/src/interview-followups.ts`; `packages/core/src/stages.ts` (PIPELINE-02, INTERVIEWS-24) | Built |
| 2A | When cancelling, the candidate chooses "Send me new times later" or "I'm no longer interested". New times go automatically only to those who asked; the team can also send new times to one person or to the whole column. | `apps/api/src/pages/schedule.tsx:392-438`; `apps/api/src/services/new-times.ts:65-116`; `apps/web/src/pages/People.tsx:439-485` (INTERVIEWS-24, -27, -28) | Built |
| 3A | Automatic new times after 3 working days by default; adjustable or switched off per company in Setup. | `packages/agents/src/new-times.ts:41, 68`; `packages/workflows/src/definitions/new-times.ts`; `apps/api/src/routes/company-settings.ts:121-143`; Setup "New times" card (INTERVIEWS-26) | Built |
| 4A | Candidate no-shows go to the same column, labelled "No-show", and are never sent times automatically. | `apps/api/src/routes/interviews.ts:233-244` (INTERVIEWS-25) | Built |
| Edge cases (10 Oct) | One automatic offer only. Switching the setting off asks whether to keep or stop times already promised. None after both self-service reschedules are used. A paused role still sends. Batch send leaves "no longer interested" unticked. The backfill covers only undecided candidate no-shows. A held candidate gets none. None during an ITS takeover. A HUMAN or "no thanks" reply stops a pending set. A company ITS has not checked gets none. | `packages/agents/src/new-times.ts:68-82`; `packages/workflows/src/new-times-reopen.ts`; `packages/core/src/interview-followups.ts:251-302`; migration 0035 backfill (INTERVIEWS-29, INTERVIEWS-30) | Built |

### 4.3 Clean visual style: 10 October 2026 (PR #28)

| Id | What you decided | Where it lives in the code | Status |
|---|---|---|---|
| Rule | No new UI libraries: everything is rebuilt in our own CSS. Motion is CSS only, reduced motion is respected, contrast meets WCAG AA, and screens suit cheap old laptops and phones. | `packages/ui/src/tokens.css`; `apps/web/src/motion.ts` | Built |
| 1C | A warm off-white "paper" light mode, and a cool near-black/grey dark mode | `packages/ui/src/tokens.css:94` | Built |
| 2A | The sliding-arrow button only on the public job page's "Apply now" | `apps/api/src/pages/job-page.tsx:71-76`; `apps/api/src/pages/layout.tsx` | Built |
| 3A | Table headings in normal case, darker grey | `packages/ui/src/tokens.css:441`; test `packages/ui/src/weight-guard.test.ts:174` | Built |
| 4A | No number tiles on Today; the figures stay in each role's Report tab | `apps/web/src/pages/Home.tsx`; `apps/web/src/pages/RoleReport.tsx` | Built |

### 4.4 Hosting: 9 October 2026

| What you decided | Where it lives in the code | Status |
|---|---|---|
| Keep Vercel, Supabase and Railway; "don't change anything" about hosting. | `apps/shell` (the Vercel app, which also serves the API: PLATFORM-01); `apps/api/src/worker.ts` and the worker service's Railway settings (the Railway worker: PLATFORM-02; `railway.json` removed 15 Oct); `packages/db` (Supabase Postgres) | Built (unchanged) |

### 4.5 AI models: 13 October 2026 (PR #36)

| What you decided | Where it lives in the code | Status |
|---|---|---|
| Only Claude Haiku 5.5 (every task) and Claude Sonnet 5.5 (only the whole job draft, `intake.compile`). Never any other model. Moving another task to Sonnet 5.5 needs evidence and a plain explanation first. | `packages/ai/src/routing.ts:8-13` (allow-list, checked at start-up), `:21-42` (which task uses which model); `packages/ai/src/runner.ts:51-54` (refused at call time) (AI-01) | Built |

### 4.6 Fairness: 13 October 2026 (PRs #37, #38)

Your words: "if haiku thinks that the score is 81 then that is okay ... the CV screening should be fair".

| What you decided | Where it lives in the code | Status |
|---|---|---|
| Three readings per application, keeping the middle answer | `packages/agents/src/triage.ts:48, 64-75, 134-151` (AI-15) | Built. The résumé reading since 13 Oct; the screening scorecard too since Wave S5 (known bugs 20 and 106 fixed). Since Wave S7 each finding is settled by its own middle reading, and the overall reading is worked out in code. |
| High effort for `triage.assess` and `screen.assess` | `packages/ai/src/routing.ts:94-98` (AI-02) | Built |
| One written definition per finding (FINDING_RULES) | `packages/ai/src/prompts/registry.ts:50-57`, used in `prompts/triage.ts` and `prompts/screen.ts` | Built |
| The candidate is never named in the readings | `packages/ai/src/prompts/triage.ts` version 3; `packages/ai/src/prompts/screen.ts` version 4 | Built. Since D-04 C (15 Oct, Wave S2) the scoring readings no longer receive the name, email, phone, street address, zip code or web links (`packages/agents/src/scoring-view.ts`; from `triage.assess` version 4 and `screen.assess` version 6, now versions 6 and 7). The résumé extraction still reads the original text to fill in the candidate's record. |
| The expired-credential rule only settles "unknown" | `packages/agents/src/triage.ts:181-188, 257` | Built. Since Wave S5 the licence-readings rule (section at the top) is enforced in code for the résumé reading and the screening scorecard (known bug 20 fixed). |
| A "Run fairness tests" GitHub Actions button on the real model | `.github/workflows/fairness.yml`; `packages/evals/src/summary.ts`; `docs/runbooks/fairness-tests.md` (AI-24) | Built. The latest run (15 Oct, after Wave S7, run 38717936154, about $0.42) passed all 11 résumé-reading and scoring suites it ran; the run after S5 had failed two bias pairs, fixed in S7. The button does not run the screening-chat tests, which have run only on the stand-in AI. Results are kept as GitHub artifacts, not in the repository. |

### 4.7 Standing product principles (from the founder documents and earlier decisions)

| Principle | Where it lives in the code | Status |
|---|---|---|
| Final hiring decisions are made by a person; no automatic rejection | `packages/core/src/stages.ts:133` (only a person may decline); `packages/core/src/policy.ts:40-51` (actions only a person may take) | Built |
| Evidence before score; the AI never pretends to be a person; a candidate can always reach a human | The score is worked out from checked findings (`packages/core/src/match-score.ts`); the AI line on candidate pages (`apps/api/src/pages/conversation-frame.tsx`, `ConversationPage`); the HUMAN keyword and "talk to a person" (`packages/agents/src/screening.ts:537, 686`); a candidate can ask for a person to review their application (AI-36) | Built |
| Deferred on purpose (September 2026): SMS switched on, interview recording, scorecards, offers and e-signature, onboarding and HR-system links, background checks, sourcing, job-board API connections, paid sponsorship, payments, Microsoft 365 calendar, rediscovery, a second jurisdiction, automatic rejection | SMS is built but switched off (OPS-07, APPLY-31). Offers are record-only (Q29). Reference and onboarding stages are defined but unreachable (PIPELINE-38). Recording, scorecards, Microsoft calendar, board APIs and sponsorship are not built (INTERVIEWS-35, INTERVIEWS-36, INTERVIEWS-05, JOBS-39, JOBS-38). | Not built, by decision |
| Counsel (lawyer) items do not block building but do block live use: AI-in-hiring notices (NYC, Illinois, California, Colorado), the NYC bias audit for a visible score, batch declines, decline wording, team notes, the pay transparency list, talent-pool wording, texting, and the Kanvis-style application (item 26) | `docs/spec/11-counsel-register.md` (items 1, 7, 10, 20 to 26); `docs/STATUS.md` | Open. The register records no counsel answers yet. Items 21 and 26 must be reviewed before real candidates in NYC, Illinois, California or Colorado, and S1's reworded apply tick box needs sign-off. |

---

## 5. Change log

| Date | Change |
|---|---|
| 14 Oct 2026 | Register created. Batch 1 (D-01 to D-05) asked. Batches 2 to 5 (L-01 to L-15) listed, not yet asked. Decisions already made reproduced in section 4 with their place in the code. |
| 14 Oct 2026 | Cross-document check: bug references changed to `known-bugs.md` row numbers; D-02 C's expiry periods aligned with the implementation plan (14-day link, 30-day wipe, counsel item 9). No option changed. |
| 14 Oct 2026 | The founder delegated batch 1 to Claude (section at the top): D-01 A, D-02 not now, D-03 A, D-04 C (next wave), D-05 not now. Wave S1 (simple screens) built on `kanvis-simple`. |
| 15 Oct 2026 | D-04 C built: the scoring readings see placeholders such as [name], [email] and [phone] instead of who the candidate is, and no longer see earlier applications to the company or how they ended; candidate text can no longer close the prompt's data blocks; quotes shown to owners are still the candidate's own words. Open: the evals runner and a fairness pair that differs only in an earlier rejection, then the founder re-runs "Run fairness tests". |
| 15 Oct 2026 | Wave S2 built on `kanvis-simple`. Kanvis-like: the Jobs list (filters, search, sort, badges, "Post on LinkedIn"), a ten-step quick start for a new job, a "Post on LinkedIn" card on the Share tab, a progress line on the candidate's status page, plain words in server-made notices, and a clean first draw on the Candidates page and Home. Fixes: monthly allowances reset, a Plan control and alert Resolve in the ITS console, critical alerts emailed to platform admins, interview scheduling that recovers (fresh windows, availability wakes interviews, "other times" emails, reschedules tell the candidate, picks never lost, no assumed 9-to-5), and deleting a candidate's data also scrubs their AI readings and AI run log. No decision changed; no migration. |
| 15 Oct 2026 | Wave S5 on `complete-product`: L-01, L-10 and L-12 decided by delegation as recommended and built; the licence-reading rule added and enforced in code; not now: the invisible bot check (L-14), hiring managers limited to their own roles (L-03), a customer second factor (L-16) and migration 0040 (section at the top). Also built: steadier scoring (three readings of the scorecard, quotes only in the candidate's own words, half marks for an unquoted yes, interview-only skills left out of the score, AI questions fairness-checked, eligibility overrides passed on), AI and email outages held and retried instead of failed, system-raised recruiter requests emailed to ITS, candidate link rotation, a company switcher, and scheduling polish (holidays, one calendar invitation, outcome recorded once). No migration. |
| 15 Oct 2026 | Wave S5 review, accepted behaviour (known-bugs row 17): an application typed with an address already on the company's records joins that person's record at once, by the form and by the one-visit chat alike, and is read like any other; what the visitor types in the chat stays apart until the address owner confirms by email. In return, the acknowledgment to the address on file now says the application was sent using their address and how to tell a person it was not them. Parking the résumé until the owner confirms is left for later. Row 16: an emailed-in application is read by AI only after the email carrying the AI notice has gone; if it never goes, it is not read by AI and the team reviews it. |
| 15 Oct 2026 | Requests raised by Recruiting OS say so in the queue; old stopped-run errors show in plain words; the candidate's name opens only after Accept (I11 unchanged). |
| 15 Oct 2026 | Review fixes: once accepted, the conversation says "Raised automatically by Recruiting OS" (or "A candidate asked for a person") instead of "The customer asked"; a held applicant's reminder says it needs a review, not a takeover; automatic candidate requests no longer blame the screening assistant; a person's own words are never reworded. I11 unchanged. |
| 15 Oct 2026 | Founder answers for Waves S6 and S7. F1: no list of topics before the screening chat, only the question counter. F2: yes, candidates may read back the answers they sent (built in the next wave, S7). F3: yes, a button folds the staff left menu to icons, remembered per browser. F4: one dollar figure for the month's AI spend on the console's Costs card is fine (ITS-only screen). S7-1: the candidate may see their match score, behind an ITS switch that is on by default. |
| 15 Oct 2026 | Wave S6 on `admin-console`: the ITS console rebuilt as an Overview ("Needs attention", a Customers card, Costs this month, a System line) and four sections with their own addresses and left-menu links (Customers, Privacy requests, Problems, System and settings), lists of at most five columns with side drawers, plain words throughout; dropdown lists readable in dark mode everywhere (one option rule in both stylesheets); a tick on the current choice in menus; a tidier ITS recruiter queue (filters, search, buttons at the top); the collapsible left menu (F3). Nothing removed: every console action is at most two clicks from `/admin` (`docs/16-admin.md`). No decision changed; no migration; one additive API option (`GET /admin/costs?since=`). |
| 15 Oct 2026 | Wave S7 on `kanvis-apply` (the Kanvis-style application, section at the top): D-01 revised to a per-company record; S7-1 (the candidate sees their score, ITS switch on by default), S7-2 (the answers sent, read back) and S7-3 (the chat's counter) built; the resume read at once to fill in the form; the company's quick and written questions; a chat with sections, one restatement and one question per message, one push and then "something similar", and no guesses; Review & send with answers written up from the candidate's own replies (the assistant's notes kept apart); the status page upgraded to the application record. Fairness fixes: a monotonic score, findings settled by the middle reading with the overall reading worked out in code, the form's answers as the candidate's own sentences. Additive API only; no migration. The candidate page files are split by part of the journey, so the line-number citations above now name the new files. Open: the real-model fairness run on this branch; whether emailed (later) chats should ask the company's written questions too. |
| 15 Oct 2026 | Wave S8 on `kanvis-followups`, decided by Claude (delegated by the founder), settling the open point above: a screening chat by email or by text message now asks the company's written questions too, after the questions left open by the résumé reading, so it asks the same questions as the web chat in the same visit (a job with no written questions asks its screening questions, exactly as before). A chat that started before this change keeps the questions it began with. The private "What a good answer shows" is never said in these chats either. They still have no Review & send and no write-up: the answers show on the candidate's panel, and the candidate's record learns from their own words when the chat is finished. Texts keep STOP, HELP and the quiet hours as they were. |
| 15 Oct 2026 | Wave S8, decided by Claude (delegated by the founder), building the part of D-01 revised left for later: a candidate who applies again from the emailed "use your details" link sees the facts their earlier chats at that company added, each one ticked, and unticks anything that is no longer true; what they keep becomes part of this application, in their own words, so the chat does not ask it again. Facts are kept only when the email typed on the form matches the address on file, and only facts that belong to that person; without the emailed link nothing from before is shown or used, so the form never reveals that an address applied before. The scoring still never sees earlier applications or how they ended (D-04 C). Kept facts are in a copy of the person's data and are erased on a deletion request. Same company only. No migration. |
| 15 Oct 2026 | Register brought up to date after Waves S1 to S8: every decision now shows who made it, when and where it is built; F4 and the S5 accepted behaviour added to the tables at the top; a Wave S8 section added (S8-A, S8-B and the founder's theme switch; PR #45 in review); one short **Still to decide** table added (L-02, L-04 to L-09, L-11, L-13, L-15 and L-17 open; D-02, D-05, L-03, L-14, L-16 and migration 0040 put off but open to asking again). Settled since the entries above: the D-04 fairness tests and earlier-rejection pair (Wave S3), the scorecard's three readings and the licence rule on it (Wave S5), and the real-model fairness run after Wave S7 (run 38717936154: all 11 résumé-reading and scoring suites passed; the run after S5 had failed two bias pairs, fixed in S7; the screening-chat tests have not yet run on the real model). Kanvis's candidate side is now OBSERVED (one complete application on 15 Oct); its recruiter side is still INFERRED. No decision changed. |
| 15 Oct 2026 | Founder request: a light/dark theme switch. A sun/moon button beside Sign out at the foot of the left menu (in the top bar on phones) switches the application between the two existing themes; the choice is remembered on that browser for a year in a small preference cookie, and with no choice the device setting is followed, as before. The candidate pages keep following the device. No new colours, no library, no migration. |
